import { describe, expect, it } from 'vitest';
import { mergeFields, renderStep, safeDestination, sanitizeEmail, nextSendingTime, followupTime, smtpFailure, classifyIncoming, referenceIds, checkpointRange, botLike, deliveryReports } from '../server/engine/content.js';
import { simpleParser } from 'mailparser';

describe('personalization and safe email rendering',()=>{
  it('blocks missing fields and malformed placeholders, and supports explicit fallbacks',()=>{
    expect(()=>mergeFields('Hello {{first_name}}',{})).toThrow('Missing personalization: first_name');
    expect(()=>mergeFields('Hello {{unclosed}',{})).toThrow('unresolved');
    expect(mergeFields('Hello {{first_name|there}}',{})).toBe('Hello there');
    expect(mergeFields('{{custom_field}}',{custom_fields:{custom_field:'Value'}})).toBe('Value');
  });
  it('escapes personalized HTML, strips scripts and prevents remote image loading',()=>{
    const rendered=renderStep({subject:'Hi {{first_name}}',body_text:'Hi {{first_name}}',body_html:'<p>{{first_name}}</p><script>alert(1)</script><img src="https://tracker.example/a">'},{first_name:'<img src=x onerror=alert(1)>'});
    expect(rendered.body_html).toContain('&lt;img');expect(rendered.body_html).not.toContain('<img');expect(rendered.body_html).not.toContain('<script');
    expect(sanitizeEmail('<a href="javascript:alert(1)">X</a><iframe src="https://evil.example"></iframe>')).not.toContain('javascript');
  });
  it('allows stored http(s) destinations only, never credentials or arbitrary schemes',()=>{
    for(const unsafe of ['javascript:alert(1)','data:text/html,x','//evil.example','file:///c:/secret','https://user:pass@example.com'])expect(safeDestination(unsafe)).toBeNull();
    expect(safeDestination('https://example.com/path?a=1&b=2')).toBe('https://example.com/path?a=1&b=2');
  });
});

const settings={timezone:'America/Los_Angeles',sending_days:[1,2,3,4,5],sending_start:'09:00',sending_end:'17:00'};
describe('timezone scheduling based on actual acceptance',()=>{
  it('retains wall-clock sending hours across spring DST and weekends',()=>{
    // Friday 16:30 PST plus three calendar days is Monday 16:30 PDT.
    expect(followupTime(new Date('2026-03-07T00:30:00Z'),3,settings).toISOString()).toBe('2026-03-09T23:30:00.000Z');
    expect(nextSendingTime(new Date('2026-03-08T10:30:00Z'),settings).toISOString()).toBe('2026-03-09T16:00:00.000Z');
  });
  it('handles fall DST and end boundaries with ISO weekdays including Sunday',()=>{
    expect(nextSendingTime(new Date('2026-11-01T09:30:00Z'),settings).toISOString()).toBe('2026-11-02T17:00:00.000Z');
    expect(nextSendingTime(new Date('2026-10-20T00:00:00Z'),settings).toISOString()).toBe('2026-10-20T16:00:00.000Z');
    expect(nextSendingTime(new Date('2026-11-01T09:30:00Z'),{...settings,sending_days:[7]}).toISOString()).toBe('2026-11-01T17:00:00.000Z');
  });
});

describe('SMTP outcome safety',()=>{
  it('never automatically retries uncertain DATA acceptance',()=>{
    expect(smtpFailure({code:'ETIMEDOUT',command:'DATA'})).toMatchObject({status:'unknown',retryable:false});
    expect(smtpFailure({code:'ESOCKET'})).toMatchObject({status:'unknown',retryable:false});
    expect(smtpFailure({code:'ECONNECTION',command:'DATA'})).toMatchObject({status:'unknown',retryable:false});
    expect(smtpFailure({code:'ECONNECTION'})).toMatchObject({status:'unknown',retryable:false});
    expect(smtpFailure({code:'ECONNECTION',command:'CONN'},{submissionStarted:true})).toMatchObject({status:'unknown',retryable:false});
  });
  it('separates definite temporary, permanent, authentication and provider failures',()=>{
    expect(smtpFailure({responseCode:450})).toMatchObject({status:'temporary',retryable:true});
    expect(smtpFailure({responseCode:550})).toMatchObject({status:'permanent',retryable:false});
    expect(smtpFailure({code:'EAUTH'})).toMatchObject({status:'auth',retryable:false});
    expect(smtpFailure({responseCode:452})).toMatchObject({status:'limit',retryable:false});
    expect(smtpFailure({code:'ESOCKET',command:'CONN'})).toMatchObject({status:'temporary',retryable:true});
  });
});

describe('incoming message classification and checkpoint recovery',()=>{
  const incoming=(headers:Record<string,string>={})=>({headers:new Map(Object.entries(headers)),from:{value:[{address:'alex@example.com'}]}});
  it('distinguishes human replies, automatic replies and delivery reports',()=>{
    expect(classifyIncoming(incoming())).toBe('human_reply');
    expect(classifyIncoming(incoming({'auto-submitted':'auto-replied'}))).toBe('automatic');
    expect(classifyIncoming(incoming({'content-type':'multipart/report; report-type=delivery-status'}))).toBe('delivery_failure');
  });
  it('extracts explicit reply identifiers without subject-line matching',()=>{
    expect(referenceIds({subject:'Re: Hello',inReplyTo:'<one@example.com>',references:['<one@example.com>','<two@example.com>']})).toEqual(['<one@example.com>','<two@example.com>']);
    expect(referenceIds({subject:'Re: Hello'})).toEqual([]);
  });
  it('recognizes structured MIME parser content types and pairs DSN recipient blocks',async()=>{
    const mime=['From: Mail Delivery <mailer-daemon@example.com>','To: sender@example.com','Message-ID: <dsn@example.com>','Subject: Delivery report','MIME-Version: 1.0','Content-Type: multipart/report; report-type=delivery-status; boundary="dsn"','','--dsn','Content-Type: text/plain','','Delivery report.','--dsn','Content-Type: message/delivery-status','','Reporting-MTA: dns; example.com','','Final-Recipient: rfc822; delayed@example.com','Action: delayed','Status: 4.2.0','','Final-Recipient: rfc822; failed@example.com','Action: failed','Status: 5.1.1','','--dsn--',''].join('\r\n');
    const parsed=await simpleParser(mime);
    expect(classifyIncoming(parsed)).toBe('delivery_failure');
    expect(deliveryReports(parsed)).toEqual([{recipient:'delayed@example.com',status:'4.2.0',action:'delayed'},{recipient:'failed@example.com',status:'5.1.1',action:'failed'}]);
    expect(classifyIncoming({headers:new Map(),from:{value:[{address:'postmaster@example.com'}]}})).toBe('uncertain');
  });
  it('restarts UID scanning after UIDVALIDITY changes and continues incrementally otherwise',()=>{
    expect(checkpointRange({uid_validity:'12',last_uid:99},'12')).toBe(100);
    expect(checkpointRange({uid_validity:'12',last_uid:99},'13')).toBe(1);
  });
  it('labels recognizable scanners without treating filtering as proof of humanity',()=>{expect(botLike('Proofpoint Link Scanner')).toBe(true);expect(botLike('Mozilla/5.0')).toBe(false);});
});
