import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { httpFixture } from './http-fixture.js';

const fake=vi.hoisted(()=>({sendMail:vi.fn(),syncMailbox:vi.fn(),beforeTransport:vi.fn()}));
vi.mock('../server/engine/mail.js',async importOriginal=>{
  const original=await importOriginal<any>();
  return {...original,smtpTransport:vi.fn(async()=>{await fake.beforeTransport();return {sendMail:fake.sendMail,close:vi.fn()};}),syncMailbox:fake.syncMailbox};
});
import { db, json } from '../server/db.js';
import { config } from '../server/config.js';
import { claimJob, reserveSend, recoverExpiredLeases, finishAccepted, runWorker, reconcileAttempt, retryFailedJobs, requestSync } from '../server/worker.js';
import { ingestIncoming, findReply } from '../server/engine/mail.js';
import { suppressEmail } from '../server/engine/policy.js';
import { publicRouter } from '../server/tracking.js';
import { campaignRouter, inboxRouter } from '../server/campaigns.js';
import { up } from '../server/migrations/001_initial.js';
import { defaultSettings } from '../server/settings.js';

const enabled=process.env.RUN_DB_TESTS==='true'&&Boolean(process.env.DB_NAME?.endsWith('_test'));
const tables=['audit_logs','tracking_events','tracked_links','tracking_tokens','mailbox_checkpoints','messages','send_attempt_events','send_attempts','jobs','enrollments','sequence_steps','campaign_versions','campaigns','templates','import_results','imports','suppressions','tasks','notes','deals','contact_consents','contacts','email_accounts','sessions','users'];
const uuid=()=>randomUUID(),date=()=>new Date();
let actor:any,account:any,contact:any;
const app=httpFixture({middleware:[(req,_res,next)=>{req.user=actor;next();}],mounts:[[publicRouter],[campaignRouter,'/api/campaigns'],[inboxRouter,'/api/inbox']]});

async function insertAccount(extra:any={}){
  const row={id:uuid(),label:'Controlled test',email:`mailbox-${uuid()}@example.com`,sender_name:'Test',smtp_host:'smtp.example.com',smtp_port:465,smtp_security:'tls',smtp_username:'test',smtp_secret:'never-used-by-fake',imap_host:'imap.example.com',imap_port:993,imap_security:'tls',imap_username:'test',imap_secret:'never-used-by-fake',status:'active',provider_policy:'opt_in_only',is_default:true,verified_at:date(),last_sync_at:date(),created_at:date(),updated_at:date(),...extra};await db('email_accounts').insert(row);return row;
}
async function insertContact(extra:any={}){
  const row={id:uuid(),email:`recipient-${uuid()}@example.com`,first_name:'Alex',last_name:'Test',company_name:'Test company',tags:JSON.stringify([]),custom_fields:JSON.stringify({}),source:'Controlled test fixture',consent_status:'test',consent_evidence:'Automated test address; fake SMTP only',created_at:date(),updated_at:date(),...extra};await db('contacts').insert(row);return row;
}
async function insertJob(extra:any={}){
  const row={id:uuid(),kind:'send',account_id:account.id,payload:JSON.stringify({is_test:true,contact_id:contact.id,content:{subject:'Controlled test',body_text:'Hello Alex',body_html:null}}),status:'queued',due_at:date(),attempts:0,created_at:date(),updated_at:date(),...extra};await db('jobs').insert(row);return row;
}
async function insertInboxMessage(extra:any={}){
  const row={id:uuid(),account_id:account.id,contact_id:contact.id,direction:'inbound',message_id:`<inbox-${uuid()}@example.test>`,references_json:JSON.stringify([]),from_email:contact.email,to_email:account.email,subject:'Controlled conversation',body_text:'Controlled inbox fixture',classification:'human_reply',is_test:false,received_at:date(),created_at:date(),...extra};await db('messages').insert(row);return row;
}
async function compose(to:string,extra:any={}){
  return request(app).post('/api/inbox/compose').send({account_id:account.id,to,subject:'Controlled personal message',body_text:'A personal note without a marketing footer.',...extra});
}
async function blockRecipient(reason:string,email=contact.email){
  if(reason==='suppressed')await suppressEmail(email,'manual','Controlled inbox test',actor.id);
  else await db('contacts').where({email}).update({consent_status:'revoked',updated_at:date()});
}
async function createCampaign(extra:any={}){
  const draft={name:'Controlled campaign',account_id:account.id,steps:[{subject:'Hello {{first_name}}',body_text:'First message',delay_days:0},{subject:'Follow up',body_text:'Second message',delay_days:3}],contact_ids:[contact.id],open_tracking:false,click_tracking:false,...extra};
  const response=await request(app).post('/api/campaigns').send(draft);expect(response.status).toBe(201);return {campaign:response.body,draft};
}
async function launch(extra:any={}){const result=await createCampaign(extra);const response=await request(app).post(`/api/campaigns/${result.campaign.id}/launch`).send({});expect(response.status,response.body.error).toBe(200);return {campaign:response.body.campaign,draft:result.draft};}
async function outboundForCampaign(){const result=await launch();const job=await claimJob(uuid());const reserved=await reserveSend(job);expect(reserved).toBeTruthy();return {...result,job,prepared:reserved!};}

describe.skipIf(!enabled)('durable engine against an isolated MySQL/MariaDB test database',()=>{
  const previousLive=config.liveSendEnabled;
  beforeAll(async()=>{if(!await db.schema.hasTable('users'))await up(db);config.liveSendEnabled=true;},30000);
  afterAll(async()=>{config.liveSendEnabled=previousLive;await db.destroy();});
  beforeEach(async()=>{
    for(const table of tables)await db(table).delete();
    actor={id:uuid(),name:'Test Owner',email:'owner@example.com',role:'owner',permissions:[]};
    await db('users').insert({...actor,permissions:JSON.stringify([]),password_hash:'not-used',disabled:false,created_at:date(),updated_at:date()});
    await db('business_settings').where({id:'agency'}).update({data:JSON.stringify({...defaultSettings,paused:false,business_address:'123 Controlled Test St',timezone:'UTC',sending_days:[1,2,3,4,5,6,7],sending_start:'00:00',sending_end:'23:59',min_interval_seconds:60,application_cap:20,provider_cap:100}),updated_at:date()});
    account=await insertAccount();contact=await insertContact();
    fake.sendMail.mockReset().mockImplementation(async(mail:any)=>({accepted:[mail.to]}));fake.syncMailbox.mockReset().mockResolvedValue({processed:0,complete:true});fake.beforeTransport.mockReset().mockResolvedValue(undefined);
  });

  it('claims concurrent work once using durable SKIP LOCKED leases',async()=>{
    await insertJob();await insertJob();
    const claimed=await Promise.all([claimJob(uuid()),claimJob(uuid()),claimJob(uuid())]);
    // Some InnoDB query plans temporarily lock the next index interval as well
    // as the selected row. A later poll drains it without duplicate ownership.
    while(claimed.filter(Boolean).length<2){const next=await claimJob(uuid());expect(next).toBeTruthy();claimed.push(next);}
    expect(claimed.filter(Boolean)).toHaveLength(2);expect(new Set(claimed.filter(Boolean).map(j=>j.id)).size).toBe(2);
    expect(await db('jobs').where({status:'leased'})).toHaveLength(2);
  });

  it('deduplicates concurrent mailbox sync requests, including an in-progress scan',async()=>{
    const requested=await Promise.all(Array.from({length:4},()=>requestSync(account.id)));
    expect(new Set(requested).size).toBe(1);expect(await db('jobs').where({kind:'sync'})).toHaveLength(1);
    const leased=await claimJob(uuid(),true);expect(leased.id).toBe(requested[0]);
    expect(await requestSync(account.id)).toBe(leased.id);expect(await db('jobs').where({kind:'sync'})).toHaveLength(1);
  });

  it('schedules the next minute from scan start rather than its completion time',async()=>{
    await runWorker({budgetMs:20000,maxJobs:5,syncOnly:true});
    const first=await db('jobs').where({kind:'sync'}).first();expect(first.status).toBe('completed');
    await db('jobs').where({id:first.id}).update({created_at:new Date(Date.now()-61000),updated_at:new Date(Date.now()-58000)});
    await runWorker({budgetMs:20000,maxJobs:5,syncOnly:true});
    expect(fake.syncMailbox).toHaveBeenCalledTimes(2);expect(await db('jobs').where({kind:'sync'})).toHaveLength(2);
    await runWorker({budgetMs:20000,maxJobs:5,syncOnly:true});
    expect(fake.syncMailbox).toHaveBeenCalledTimes(2);expect(await db('send_attempts')).toHaveLength(0);expect(fake.sendMail).not.toHaveBeenCalled();
  });

  it('continues an incomplete old scan without creating overlapping mailbox jobs',async()=>{
    const syncId=await requestSync(account.id);await db('jobs').where({id:syncId}).update({created_at:new Date(Date.now()-120000)});
    fake.syncMailbox.mockResolvedValueOnce({processed:50,complete:false});
    await runWorker({budgetMs:20000,maxJobs:1,syncOnly:true});
    expect((await db('jobs').where({id:syncId}).first()).status).toBe('queued');
    await db('jobs').where({id:syncId}).update({due_at:date()});
    await runWorker({budgetMs:20000,maxJobs:1,syncOnly:true});
    expect(fake.syncMailbox).toHaveBeenCalledTimes(2);expect(await db('jobs').where({kind:'sync'})).toHaveLength(1);expect((await db('jobs').where({id:syncId}).first()).status).toBe('completed');
  });

  it('limits Inbox workers to sync and strictly typed manual sends, with sync-only taking precedence',async()=>{
    const campaignJob=await insertJob(),malformedManual=await insertJob({payload:JSON.stringify({is_manual:'true',manual_recipient:'unreviewed@example.test'})});
    const manual=await compose('inbox-only@example.test');expect(manual.status).toBe(202);
    await runWorker({budgetMs:20000,maxJobs:5,inboxOnly:true});
    expect(fake.syncMailbox).toHaveBeenCalledTimes(1);expect(fake.sendMail).toHaveBeenCalledTimes(1);expect(fake.sendMail.mock.calls[0][0].to).toBe('inbox-only@example.test');
    expect((await db('jobs').where({id:campaignJob.id}).first()).status).toBe('queued');expect((await db('jobs').where({id:malformedManual.id}).first()).status).toBe('queued');
    const heldManual=await compose('sync-only@example.test');expect(heldManual.status).toBe(202);
    await runWorker({budgetMs:20000,maxJobs:5,syncOnly:true,inboxOnly:true});
    expect(fake.sendMail).toHaveBeenCalledTimes(1);expect(await db('send_attempts').where({job_id:heldManual.body.job_id})).toHaveLength(0);
  });

  it('sends individually written mail outside campaign hours and pacing while keeping automated work delayed',async()=>{
    const first=await compose('first-person@example.test');expect(first.status).toBe(202);
    await runWorker({budgetMs:20000,maxJobs:5,inboxOnly:true});expect(fake.sendMail).toHaveBeenCalledTimes(1);
    const tomorrowWeekday=(new Date().getUTCDay()||7)%7+1;
    const settings={...defaultSettings,paused:false,business_address:'123 Test St',timezone:'UTC',sending_days:[tomorrowWeekday],min_interval_seconds:86400};
    await db('business_settings').where({id:'agency'}).update({data:JSON.stringify(settings)});
    const second=await compose('second-person@example.test'),source=await insertInboxMessage();
    const reply=await request(app).post(`/api/inbox/${source.id}/reply`).send({body_text:'A timely personal reply.'});expect(reply.status).toBe(202);
    const campaignJob=await insertJob();await runWorker({budgetMs:20000,maxJobs:5,inboxOnly:true});
    expect(fake.sendMail).toHaveBeenCalledTimes(3);expect((await db('jobs').where({id:second.body.job_id}).first()).status).toBe('completed');expect((await db('jobs').where({id:reply.body.job_id}).first()).status).toBe('completed');
    expect(await reserveSend(await claimJob(uuid()))).toBeNull();expect((await db('jobs').where({id:campaignJob.id}).first()).last_error).toContain('sending window');
    await db('business_settings').where({id:'agency'}).update({data:JSON.stringify({...settings,sending_days:[1,2,3,4,5,6,7],sending_start:'00:00',sending_end:'23:59'})});await db('jobs').where({id:campaignJob.id}).update({due_at:date()});
    expect(await reserveSend(await claimJob(uuid()))).toBeNull();expect((await db('jobs').where({id:campaignJob.id}).first()).last_error).toContain('Minimum interval');
  });

  it('keeps the shared rolling sending cap for immediate manual mail',async()=>{
    await db('business_settings').where({id:'agency'}).update({data:JSON.stringify({...defaultSettings,paused:false,application_cap:1})});
    const first=await compose('capacity-first@example.test');expect(first.status).toBe(202);await runWorker({budgetMs:20000,maxJobs:5,inboxOnly:true});
    const second=await compose('capacity-second@example.test');expect(second.status).toBe(202);await runWorker({budgetMs:20000,maxJobs:5,inboxOnly:true});
    expect(fake.sendMail).toHaveBeenCalledTimes(1);expect(await db('send_attempts').where({job_id:second.body.job_id})).toHaveLength(0);expect((await db('jobs').where({id:second.body.job_id}).first()).last_error).toContain('capacity');
  });

  it('holds an unknown manual SMTP outcome instead of resubmitting on the next Inbox tick',async()=>{
    const queued=await compose('unknown-outcome@example.test');expect(queued.status).toBe(202);fake.sendMail.mockRejectedValueOnce({code:'ETIMEDOUT',command:'DATA'});
    await runWorker({budgetMs:20000,maxJobs:5,inboxOnly:true});await runWorker({budgetMs:20000,maxJobs:5,inboxOnly:true});
    expect(fake.sendMail).toHaveBeenCalledTimes(1);expect((await db('jobs').where({id:queued.body.job_id}).first()).status).toBe('held');expect(await db('send_attempts').where({job_id:queued.body.job_id})).toMatchObject([{status:'unknown',retryable:0}]);
  });

  it('serializes capacity reservations across concurrent workers and mailboxes',async()=>{
    await db('business_settings').where({id:'agency'}).update({data:JSON.stringify({...defaultSettings,paused:false,business_address:'123 Test St',timezone:'UTC',sending_days:[1,2,3,4,5,6,7],sending_start:'00:00',sending_end:'23:59',application_cap:1,provider_cap:100})});
    const second=await insertAccount();await insertJob();await insertJob({account_id:second.id});
    const jobs=[await claimJob(uuid()),await claimJob(uuid())],reserved=await Promise.all(jobs.map(j=>reserveSend(j)));
    expect(reserved.filter(Boolean)).toHaveLength(1);expect(await db('send_attempts').where({status:'reserved'})).toHaveLength(1);expect(await db('jobs').where({status:'queued'})).toHaveLength(1);
  });

  it('blocks stale sync and rechecks suppression at actual reservation time',async()=>{
    await db('email_accounts').where({id:account.id}).update({last_sync_at:new Date(Date.now()-3600000)});await insertJob();await reserveSend(await claimJob(uuid()));
    expect(await db('send_attempts')).toHaveLength(0);expect((await db('jobs').first()).last_error).toContain('stale');
    await db('email_accounts').where({id:account.id}).update({last_sync_at:date()});await db('jobs').update({due_at:date()});await suppressEmail(contact.email,'manual','integration test',actor.id);await reserveSend(await claimJob(uuid()));
    expect(await db('send_attempts')).toHaveLength(0);expect((await db('jobs').first()).status).toBe('cancelled');
  });

  it('recovers a reservation safely but holds a submission after a restart',async()=>{
    await insertJob();let job=await claimJob(uuid()),prepared=await reserveSend(job);expect(prepared).toBeTruthy();
    await db('jobs').where({id:job.id}).update({lease_until:new Date(Date.now()-1)});await recoverExpiredLeases();expect((await db('jobs').where({id:job.id}).first()).status).toBe('queued');
    job=await claimJob(uuid());prepared=await reserveSend(job);await db('send_attempts').where({id:prepared!.attempt.id}).update({status:'submitting',submitted_at:date()});await db('jobs').where({id:job.id}).update({lease_until:new Date(Date.now()-1)});await recoverExpiredLeases();
    expect((await db('send_attempts').first()).status).toBe('unknown');expect((await db('jobs').first()).status).toBe('held');
    expect(await retryFailedJobs(actor.id)).toEqual({retried:0});expect(await claimJob(uuid())).toBeNull();
    await reconcileAttempt(prepared!.attempt.id,'not_sent',actor.id);expect((await db('jobs').first()).status).toBe('queued');
  });

  it('uses fake SMTP, reuses stable Message-ID after a definite rejection, and only schedules after acceptance',async()=>{
    const {campaign}=await launch();fake.sendMail.mockRejectedValueOnce({code:'EENVELOPE',responseCode:450,command:'DATA'});
    await runWorker({budgetMs:20000,maxJobs:5});
    let first=await db('jobs').where({campaign_id:campaign.id,step_position:0}).first();expect(first.status).toBe('queued');expect(await db('jobs').where({campaign_id:campaign.id,step_position:1})).toHaveLength(0);
    const stableId=(await db('send_attempts').first()).message_id;await db('jobs').where({id:first.id}).update({due_at:date()});
    await runWorker({budgetMs:20000,maxJobs:5});
    expect(fake.sendMail).toHaveBeenCalledTimes(2);expect(fake.sendMail.mock.calls[0][0].messageId).toBe(stableId);expect(fake.sendMail.mock.calls[1][0].messageId).toBe(stableId);
    const attempt=await db('send_attempts').first(),next=await db('jobs').where({campaign_id:campaign.id,step_position:1}).first();expect(attempt.status).toBe('accepted');expect(new Date(next.due_at).getTime()).toBeGreaterThan(new Date(attempt.accepted_at).getTime()+2*86400000);
    expect((await db('send_attempt_events').where({attempt_id:attempt.id}).orderBy('ordinal')).map(e=>e.status)).toEqual(['temporary','accepted']);
    const listed=await request(app).get('/api/campaigns');expect(listed.status).toBe(200);expect(listed.body.items.find((c:any)=>c.id===campaign.id)).toMatchObject({accepted:1,human_replies:0,account_email:account.email});
  });

  it('holds ambiguous SMTP responses without automatic retries and reconciles acceptance once',async()=>{
    const {campaign}=await launch();fake.sendMail.mockRejectedValueOnce({code:'ECONNECTION',command:'CONN'});await runWorker({budgetMs:20000,maxJobs:5});
    const attempt=await db('send_attempts').where({campaign_id:campaign.id}).first();expect(attempt.status).toBe('unknown');expect((await db('jobs').where({id:attempt.job_id}).first()).status).toBe('held');
    await runWorker({budgetMs:20000,maxJobs:5});expect(fake.sendMail).toHaveBeenCalledTimes(1);
    const confirmedAfter=Date.now();await reconcileAttempt(attempt.id,'accepted',actor.id);expect(await db('jobs').where({campaign_id:campaign.id,step_position:1})).toHaveLength(1);expect(new Date((await db('send_attempts').where({id:attempt.id}).first()).accepted_at).getTime()).toBeGreaterThanOrEqual(confirmedAfter);
    await expect(reconcileAttempt(attempt.id,'accepted',actor.id)).rejects.toThrow('Only unknown');
  });

  it('matches references, deduplicates incoming messages and cancels followups agency-wide',async()=>{
    const first=await outboundForCampaign();await finishAccepted(first.prepared.attempt.id);await launch({name:'Other campaign'});
    const parsed={messageId:'<reply-unique@example.com>',inReplyTo:first.prepared.message.message_id,references:[first.prepared.message.message_id],headers:new Map(),from:{value:[{address:contact.email}]},subject:'Unrelated subject',text:'Thank you',date:date()};
    expect((await findReply(parsed,account.id))?.contact_id).toBe(contact.id);
    const result=await db.transaction(trx=>ingestIncoming(account,parsed,1,'1',trx));expect(result.message.classification).toBe('human_reply');
    expect(await db('enrollments').where({contact_id:contact.id,status:'active'})).toHaveLength(0);expect(await db('jobs').where({kind:'send',status:'queued'})).toHaveLength(0);
    const duplicate=await db.transaction(trx=>ingestIncoming(account,parsed,1,'1',trx));expect(duplicate.duplicate).toBe(true);expect(await db('messages').where({direction:'inbound'})).toHaveLength(1);
  });

  it('rejects manually matching an inbound message to a different email without changing its match',async()=>{
    const message=await insertInboxMessage({contact_id:null,classification:'unmatched',from_email:'different-sender@example.test'});
    const response=await request(app).patch(`/api/inbox/${message.id}`).send({contact_id:contact.id});
    expect(response.status).toBe(400);expect(response.body.error).toContain('email matches this message sender');
    expect((await db('messages').where({id:message.id}).first()).contact_id).toBeNull();
    expect(await db('audit_logs').where({action:'inbox.updated',entity_id:message.id})).toHaveLength(0);
    expect(await db('jobs').where({kind:'send'})).toHaveLength(0);
  });

  it('matches normalized sender addresses and pins a queued reply to the original conversation',async()=>{
    const message=await insertInboxMessage({contact_id:null,classification:'unmatched',from_email:`  ${contact.email.toUpperCase()}  `});
    const matched=await request(app).patch(`/api/inbox/${message.id}`).send({contact_id:contact.id});
    expect(matched.status,matched.body.error).toBe(200);
    const queued=await request(app).post(`/api/inbox/${message.id}/reply`).send({body_text:'Controlled manual reply'});
    expect(queued.status,queued.body.error).toBe(202);
    const job=await db('jobs').where({id:queued.body.job_id}).first(),payload=json(job.payload,{});
    expect(payload).toMatchObject({is_manual:true,is_reply:true,manual_recipient:contact.email,reply_source_id:message.id,reply_recipient:contact.email,in_reply_to:message.message_id});
    expect(job.account_id).toBe(account.id);
    await runWorker({budgetMs:20000,maxJobs:5});
    expect(fake.sendMail).toHaveBeenCalledOnce();expect(fake.sendMail.mock.calls[0][0].to).toBe(contact.email);
    expect((await db('jobs').where({id:job.id}).first()).status).toBe('completed');
  });

  it('replies to the external sender despite an incorrect legacy contact match without creating contacts',async()=>{
    const message=await insertInboxMessage({from_email:'different-sender@example.test'});
    const response=await request(app).post(`/api/inbox/${message.id}/reply`).send({body_text:'Reply to the actual sender'});
    expect(response.status,response.body.error).toBe(202);
    await runWorker({budgetMs:20000,maxJobs:5});
    expect(fake.sendMail).toHaveBeenCalledOnce();expect(fake.sendMail.mock.calls[0][0].to).toBe(message.from_email);
    expect((await db('messages').where({id:message.id}).first()).contact_id).toBe(contact.id);
    expect(await db('contacts')).toHaveLength(1);expect(await db('contact_consents')).toHaveLength(0);
    expect((await db('send_attempts').where({job_id:response.body.job_id}).first()).contact_id).toBeNull();
  });

  it('keeps a queued manual reply anchored when the old contact email changes before reservation',async()=>{
    const message=await insertInboxMessage(),response=await request(app).post(`/api/inbox/${message.id}/reply`).send({body_text:'Pinned recipient only'});
    expect(response.status,response.body.error).toBe(202);
    await db('contacts').where({id:contact.id}).update({email:`changed-${uuid()}@example.test`});
    await runWorker({budgetMs:20000,maxJobs:5});
    const job=await db('jobs').where({id:response.body.job_id}).first();
    expect(job.status).toBe('completed');expect(fake.sendMail).toHaveBeenCalledOnce();
    expect(fake.sendMail.mock.calls[0][0].to).toBe(message.from_email);
    expect((await db('send_attempts').where({job_id:job.id}).first()).recipient).toBe(message.from_email);
  });

  it('keeps the immutable manual reply destination after contact edits during transport preparation',async()=>{
    const message=await insertInboxMessage(),response=await request(app).post(`/api/inbox/${message.id}/reply`).send({body_text:'Pinned recipient only'});
    expect(response.status,response.body.error).toBe(202);
    fake.beforeTransport.mockImplementationOnce(async()=>{await db('contacts').where({id:contact.id}).update({email:`changed-${uuid()}@example.test`});});
    await runWorker({budgetMs:20000,maxJobs:5});
    const job=await db('jobs').where({id:response.body.job_id}).first(),attempt=await db('send_attempts').where({job_id:job.id}).first();
    expect(fake.beforeTransport).toHaveBeenCalledOnce();expect(fake.sendMail).toHaveBeenCalledOnce();
    expect(fake.sendMail.mock.calls[0][0].to).toBe(message.from_email);
    expect(job.status).toBe('completed');expect(attempt.status).toBe('accepted');expect(attempt.recipient).toBe(message.from_email);
  });

  it('replies from a selected outbound message to its original external recipient through fake SMTP',async()=>{
    const message=await insertInboxMessage({direction:'outbound',classification:'outbound',from_email:account.email,to_email:contact.email});
    const response=await request(app).post(`/api/inbox/${message.id}/reply`).send({body_text:'Continue controlled conversation'});
    expect(response.status,response.body.error).toBe(202);
    const job=await db('jobs').where({id:response.body.job_id}).first(),payload=typeof job.payload==='string'?JSON.parse(job.payload):job.payload;
    expect(payload).toMatchObject({reply_source_id:message.id,reply_recipient:contact.email});
    await runWorker({budgetMs:20000,maxJobs:5});
    expect(fake.sendMail).toHaveBeenCalledOnce();expect(fake.sendMail.mock.calls[0][0]).toMatchObject({to:contact.email,inReplyTo:message.message_id});
    expect((await db('jobs').where({id:job.id}).first()).status).toBe('completed');
    expect((await db('send_attempts').where({job_id:job.id}).first()).recipient).toBe(contact.email);
  });

  it('cancels older reply jobs with no verifiable original recipient instead of sending',async()=>{
    const job=await insertJob({payload:JSON.stringify({is_reply:true,contact_id:contact.id,in_reply_to:'<old-message@example.test>',content:{subject:'Re: Earlier message',body_text:'Legacy reply',body_html:null}})});
    await runWorker({budgetMs:20000,maxJobs:5});
    const result=await db('jobs').where({id:job.id}).first();
    expect(result.status).toBe('cancelled');expect(result.last_error).toContain('Reply recipient could not be verified');
    expect(fake.sendMail).not.toHaveBeenCalled();expect(await db('send_attempts').where({job_id:job.id})).toHaveLength(0);
  });

  it('composes to an address outside Contacts without marketing content, tracking or contact creation',async()=>{
    const settings=await db('business_settings').where({id:'agency'}).first();
    await db('business_settings').where({id:'agency'}).update({data:JSON.stringify({...json(settings.data,{}),business_address:'',signature:'Marketing signature'})});
    const recipient='new-person@example.test',response=await compose(`  ${recipient.toUpperCase()}  `);
    expect(response.status,response.body.error).toBe(202);
    const job=await db('jobs').where({id:response.body.job_id}).first();
    expect(json(job.payload,{})).toMatchObject({is_manual:true,manual_recipient:recipient,contact_id:null});
    await runWorker({budgetMs:20000,maxJobs:5});
    expect(fake.sendMail).toHaveBeenCalledOnce();const sent=fake.sendMail.mock.calls[0][0];
    expect(sent).toMatchObject({to:recipient,subject:'Controlled personal message',text:'A personal note without a marketing footer.'});
    expect(sent.headers?.['List-Unsubscribe']).toBeUndefined();
    const attempt=await db('send_attempts').where({job_id:job.id}).first(),message=await db('messages').where({attempt_id:attempt.id}).first();
    expect(attempt.contact_id).toBeNull();expect(Boolean(attempt.is_test)).toBe(false);expect(Boolean(attempt.is_reply)).toBe(false);
    expect(message.contact_id).toBeNull();expect(message.to_email).toBe(recipient);expect(message.body_text).toBe(sent.text);
    expect(await db('tracking_tokens')).toHaveLength(0);expect(await db('tracked_links')).toHaveLength(0);
    expect(await db('contacts')).toHaveLength(1);expect(await db('contact_consents')).toHaveLength(0);
  });

  it('allows a personal message with unknown consent while preserving campaign and test-send consent gates',async()=>{
    await db('contacts').where({id:contact.id}).update({consent_status:'unknown',consent_evidence:''});
    const response=await compose(contact.email);expect(response.status,response.body.error).toBe(202);
    await runWorker({budgetMs:20000,maxJobs:5});expect(fake.sendMail).toHaveBeenCalledOnce();
    const saved=await db('contacts').where({id:contact.id}).first();expect(saved.consent_status).toBe('unknown');expect(saved.consent_evidence).toBe('');
    expect(await db('contact_consents')).toHaveLength(0);
    const {campaign}=await createCampaign();
    expect((await request(app).post(`/api/campaigns/${campaign.id}/launch`).send({})).status).toBe(400);
    expect((await request(app).post(`/api/campaigns/${campaign.id}/test`).send({contact_id:contact.id})).status).toBe(400);
    expect(await db('enrollments')).toHaveLength(0);expect(await db('jobs').where({campaign_id:campaign.id,kind:'send'})).toHaveLength(0);
  });

  it('replies to contactless inbound messages and displays the address conversation without unrelated legacy matches',async()=>{
    const recipient='contactless@example.test',response=await compose(recipient);expect(response.status,response.body.error).toBe(202);
    await runWorker({budgetMs:20000,maxJobs:5});
    const sent=await db('messages').where({direction:'outbound',to_email:recipient}).first();
    const parsed={messageId:'<contactless-reply@example.test>',inReplyTo:sent.message_id,references:[sent.message_id],headers:new Map(),from:{value:[{address:recipient}]},subject:'Different subject',text:'Normal incoming reply',date:date()};
    expect((await findReply(parsed,account.id))?.id).toBe(sent.id);
    const incoming=await db.transaction(trx=>ingestIncoming(account,parsed,11,'1',trx));
    expect(incoming.message.contact_id).toBeNull();expect(incoming.message.classification).toBe('human_reply');
    const unrelated=await insertInboxMessage({contact_id:contact.id,from_email:'unrelated@example.test'});
    const anotherAccount=await insertAccount({is_default:false});
    const otherMailbox=await insertInboxMessage({account_id:anotherAccount.id,contact_id:null,from_email:recipient});
    const detail=await request(app).get(`/api/inbox/${incoming.message.id}`);expect(detail.status,detail.body.error).toBe(200);
    const threadIds=detail.body.thread.map((message:any)=>message.id);
    expect(threadIds).toContain(sent.id);expect(threadIds).toContain(incoming.message.id);expect(threadIds).not.toContain(unrelated.id);expect(threadIds).not.toContain(otherMailbox.id);
    const reply=await request(app).post(`/api/inbox/${incoming.message.id}/reply`).send({body_text:'No contact match is required'});
    expect(reply.status,reply.body.error).toBe(202);
    expect(json((await db('jobs').where({id:reply.body.job_id}).first()).payload,{})).toMatchObject({is_manual:true,manual_recipient:recipient,reply_source_id:incoming.message.id});
    expect(await db('contacts')).toHaveLength(1);expect(await db('contact_consents')).toHaveLength(0);
  });

  it.each(['suppressed','revoked'])('blocks compose and reply enqueue for an address that is %s',async reason=>{
    const message=await insertInboxMessage();await blockRecipient(reason);
    const created=await compose(contact.email),reply=await request(app).post(`/api/inbox/${message.id}/reply`).send({body_text:'Blocked personal reply'});
    expect(created.status).toBe(400);expect(reply.status).toBe(400);
    expect(created.body.error).toContain(reason==='suppressed'?'suppressed':'revoked');expect(reply.body.error).toContain(reason==='suppressed'?'suppressed':'revoked');
    expect(await db('jobs').where({kind:'send'})).toHaveLength(0);expect(fake.sendMail).not.toHaveBeenCalled();
  });

  it.each(['suppressed','revoked'])('rechecks %s recipient policy after compose and reply are queued',async reason=>{
    const message=await insertInboxMessage(),created=await compose(contact.email),reply=await request(app).post(`/api/inbox/${message.id}/reply`).send({body_text:'Queued before policy change'});
    expect(created.status,created.body.error).toBe(202);expect(reply.status,reply.body.error).toBe(202);
    await blockRecipient(reason);await runWorker({budgetMs:20000,maxJobs:5});
    for(const jobId of [created.body.job_id,reply.body.job_id]){
      expect((await db('jobs').where({id:jobId}).first()).status).toBe('cancelled');expect(await db('send_attempts').where({job_id:jobId})).toHaveLength(0);
    }
    expect(fake.sendMail).not.toHaveBeenCalled();
  });

  it.each(['suppressed','revoked'])('rechecks %s policy after manual reply preparation and before SMTP',async reason=>{
    const message=await insertInboxMessage(),response=await request(app).post(`/api/inbox/${message.id}/reply`).send({body_text:'Prepared before policy change'});
    expect(response.status,response.body.error).toBe(202);
    fake.beforeTransport.mockImplementationOnce(async()=>{await blockRecipient(reason);});await runWorker({budgetMs:20000,maxJobs:5});
    const attempt=await db('send_attempts').where({job_id:response.body.job_id}).first();
    expect(fake.beforeTransport).toHaveBeenCalledOnce();expect(fake.sendMail).not.toHaveBeenCalled();
    expect(attempt.status).toBe('cancelled');expect(attempt.submitted_at).toBeNull();
  });

  it.each(['source_recipient','source_account','in_reply_to'])('cancels a manual reply if its %s anchor changes after queueing',async change=>{
    const message=await insertInboxMessage({contact_id:null}),response=await request(app).post(`/api/inbox/${message.id}/reply`).send({body_text:'Keep reply anchors intact'});
    expect(response.status,response.body.error).toBe(202);
    if(change==='source_recipient')await db('messages').where({id:message.id}).update({from_email:'tampered@example.test'});
    if(change==='source_account')await db('messages').where({id:message.id}).update({account_id:(await insertAccount({is_default:false})).id});
    if(change==='in_reply_to'){
      const job=await db('jobs').where({id:response.body.job_id}).first();await db('jobs').where({id:job.id}).update({payload:JSON.stringify({...json(job.payload,{}),in_reply_to:'<tampered@example.test>'})});
    }
    await runWorker({budgetMs:20000,maxJobs:5});
    expect((await db('jobs').where({id:response.body.job_id}).first()).status).toBe('cancelled');expect(fake.sendMail).not.toHaveBeenCalled();
  });

  it.each(['none','attempt','message'])('retries a definite manual rejection with stable recipient unless persisted %s destination drifts',async drift=>{
    const response=await compose('retry-person@example.test');expect(response.status,response.body.error).toBe(202);
    fake.sendMail.mockRejectedValueOnce({code:'EENVELOPE',responseCode:450,command:'DATA'});await runWorker({budgetMs:20000,maxJobs:5});
    const attempt=await db('send_attempts').where({job_id:response.body.job_id}).first();expect(attempt.status).toBe('temporary');
    if(drift==='attempt')await db('send_attempts').where({id:attempt.id}).update({recipient:'tampered@example.test'});
    if(drift==='message')await db('messages').where({attempt_id:attempt.id}).update({to_email:'tampered@example.test'});
    await db('jobs').where({id:response.body.job_id}).update({due_at:date()});await runWorker({budgetMs:20000,maxJobs:5});
    expect(fake.sendMail).toHaveBeenCalledTimes(drift==='none'?2:1);
    if(drift==='none'){
      expect(fake.sendMail.mock.calls[1][0]).toMatchObject({to:'retry-person@example.test',messageId:attempt.message_id});
      expect((await db('jobs').where({id:response.body.job_id}).first()).status).toBe('completed');
    }else expect((await db('jobs').where({id:response.body.job_id}).first()).status).toBe('cancelled');
  });

  it('validates compose fields and inbox permissions before queueing',async()=>{
    for(const body of [{to:'not-an-email'},{to:'first@example.test,second@example.test'},{subject:'Injected\r\nBcc: other@example.test'},{subject:''},{body_text:''},{account_id:'not-a-uuid'},{contact_id:contact.id}]){
      expect((await compose('new@example.test',body)).status).toBe(400);
    }
    const originalActor=actor;actor=undefined;expect((await compose('new@example.test')).status).toBe(401);
    actor={...originalActor,role:'member',permissions:[]};expect((await compose('new@example.test')).status).toBe(403);
    actor={...originalActor,role:'member',permissions:['inbox:write']};expect((await compose('new@example.test')).status).toBe(202);actor=originalActor;
    expect(await db('jobs').where({kind:'send'})).toHaveLength(1);expect(fake.sendMail).not.toHaveBeenCalled();
  });

  it.each(['disabled','paused','stale','inactive'])('keeps the normal %s sending gate for manual compose',async gate=>{
    const response=await compose('gated-person@example.test');expect(response.status,response.body.error).toBe(202);
    if(gate==='disabled')config.liveSendEnabled=false;
    if(gate==='paused'){const settings=await db('business_settings').where({id:'agency'}).first();await db('business_settings').where({id:'agency'}).update({data:JSON.stringify({...json(settings.data,{}),paused:true})});}
    if(gate==='stale')await db('email_accounts').where({id:account.id}).update({last_sync_at:new Date(Date.now()-3600000)});
    if(gate==='inactive')await db('email_accounts').where({id:account.id}).update({status:'inactive'});
    try{await runWorker({budgetMs:20000,maxJobs:5});expect(fake.sendMail).not.toHaveBeenCalled();expect(await db('send_attempts').where({job_id:response.body.job_id})).toHaveLength(0);}
    finally{config.liveSendEnabled=true;}
  });

  it('keeps automatic replies out of human metrics and pauses known senders without subject matching',async()=>{
    const first=await outboundForCampaign();await finishAccepted(first.prepared.attempt.id);
    const parsed={messageId:'<auto@example.com>',inReplyTo:first.prepared.message.message_id,headers:new Map([['auto-submitted','auto-replied']]),from:{value:[{address:contact.email}]},subject:'Re: Same subject',text:'Out of office'};
    const result=await db.transaction(trx=>ingestIncoming(account,parsed,2,'1',trx));expect(result.message.classification).toBe('automatic');expect((await db('enrollments').first()).status).toBe('paused');expect(await db('messages').where({classification:'human_reply'})).toHaveLength(0);
    const second=await db.transaction(trx=>ingestIncoming(account,{...parsed,messageId:'<second-auto@example.com>'},3,'1',trx));
    const firstReviewed=await request(app).post(`/api/inbox/${result.message.id}/review`).send({action:'resume'});expect(firstReviewed.status).toBe(200);expect(firstReviewed.body.resumed).toBe(false);expect((await db('messages').where({id:result.message.id}).first()).review_action).toBe('resume');expect((await db('enrollments').first()).status).toBe('paused');
    const reviewed=await request(app).post(`/api/inbox/${second.message.id}/review`).send({action:'resume'});expect(reviewed.status,reviewed.body.error).toBe(200);expect(reviewed.body.resumed).toBe(true);expect((await db('enrollments').first()).status).toBe('active');expect((await db('jobs').where({step_position:1}).first()).status).toBe('queued');
  });

  it('pairs permanent DSN status with the actual target and counts only real matched failures',async()=>{
    const {prepared}=await outboundForCampaign();await finishAccepted(prepared.attempt.id);
    const base={inReplyTo:prepared.message.message_id,headers:new Map([['content-type',{value:'multipart/report',params:{'report-type':'delivery-status'}}]]),from:{value:[{address:'mailer-daemon@example.com'}]},subject:'Delivery report',attachments:[]};
    const delayed={...base,messageId:'<mixed-delay@example.com>',text:`Final-Recipient: rfc822; ${contact.email}\r\nAction: delayed\r\nStatus: 4.2.0\r\n\r\nFinal-Recipient: rfc822; other@example.com\r\nAction: failed\r\nStatus: 5.1.1`};
    const first=await db.transaction(trx=>ingestIncoming(account,delayed,1,'1',trx));expect(first.message.classification).toBe('uncertain');expect(await db('suppressions')).toHaveLength(0);expect(await db('tracking_events').where({kind:'bounce'})).toHaveLength(0);
    const failed={...base,messageId:'<matched-failure@example.com>',text:`Final-Recipient: rfc822; ${contact.email}\r\nAction: failed\r\nStatus: 5.1.1`};
    const second=await db.transaction(trx=>ingestIncoming(account,failed,2,'1',trx));expect(second.message.classification).toBe('delivery_failure');expect((await db('suppressions').first()).email).toBe(contact.email);expect(await db('tracking_events').where({kind:'bounce'})).toHaveLength(1);
  });

  it('never suppresses on GET, honors one-click POST and rejects unsafe stored redirects',async()=>{
    const {prepared}=await outboundForCampaign(),token=await db('tracking_tokens').where({message_id:prepared.message.id,kind:'unsubscribe'}).first();
    expect(await db('tracking_tokens').where({message_id:prepared.message.id,kind:'tracking'})).toHaveLength(0);
    expect((await request(app).get(`/unsubscribe/${token.id}`)).status).toBe(200);expect(await db('suppressions')).toHaveLength(0);
    const post=await request(app).post(`/unsubscribe/${token.id}`).type('form').send({'List-Unsubscribe':'One-Click'});expect(post.status).toBe(200);expect((await db('suppressions').first()).email).toBe(contact.email);expect((await db('enrollments').first()).status).toBe('stopped');
    const linkToken='a'.repeat(64);await db('tracked_links').insert({id:uuid(),token:linkToken,message_id:prepared.message.id,campaign_id:prepared.message.campaign_id,url:'javascript:alert(1)',created_at:date()});
    expect((await request(app).get(`/t/click/${linkToken}?url=https://evil.example`)).status).toBe(404);
    await db('tracked_links').where({token:linkToken}).update({url:'https://example.com/review'});const redirect=await request(app).get(`/t/click/${linkToken}?url=https://evil.example`);expect(redirect.headers.location).toBe('https://example.com/review');
  });

  it('keeps accepted content immutable on revision and preserves original mailbox during migration',async()=>{
    const {campaign,draft,prepared}=await outboundForCampaign();await finishAccepted(prepared.attempt.id);
    const secondAccount=await insertAccount({is_default:false});await db('email_accounts').update({is_default:false});await db('email_accounts').where({id:secondAccount.id}).update({is_default:true});
    const revised={...draft,steps:[draft.steps[0],{subject:'Approved revision',body_text:'New unsent content',delay_days:5}]};
    const response=await request(app).post(`/api/campaigns/${campaign.id}/revise`).send({confirmed:true,draft:revised});expect(response.status,response.body.error).toBe(200);
    expect(await db('campaign_versions').where({campaign_id:campaign.id})).toHaveLength(2);expect((await db('messages').where({id:prepared.message.id}).first()).body_text).toContain('First message');
    expect((await db('enrollments').where({campaign_id:campaign.id}).first()).account_id).toBe(account.id);expect((await db('jobs').where({campaign_id:campaign.id,step_position:1}).first()).account_id).toBe(account.id);
    const replacement=await request(app).post(`/api/campaigns/${campaign.id}/revise`).send({confirmed:true,draft:{...revised,account_id:secondAccount.id}});expect(replacement.status).toBe(400);
  });

  it('updates UID checkpoints incrementally, restarts on UIDVALIDITY, and deduplicates replay',async()=>{
    const actual=await vi.importActual<any>('../server/engine/mail.js');
    const source=Buffer.from(`From: ${contact.email}\r\nTo: ${account.email}\r\nMessage-ID: <checkpoint-test@example.com>\r\nSubject: Controlled message\r\n\r\nHello`);
    const ranges:string[]=[];
    const client=(validity:string)=>({mailbox:{uidValidity:validity,uidNext:2},on:vi.fn(),connect:vi.fn(),getMailboxLock:async()=>({release:vi.fn()}),search:async()=>[1],fetch:async function*(range:string){ranges.push(range);yield {uid:1,size:source.length,envelope:{}};},fetchOne:async()=>({source}),logout:vi.fn(),close:vi.fn()});
    expect(await actual.syncMailbox(account,{client:client('1'),deadline:Date.now()+20000})).toEqual({processed:1,complete:true});
    expect(await actual.syncMailbox(account,{client:client('1'),deadline:Date.now()+20000})).toEqual({processed:0,complete:true});
    expect(await actual.syncMailbox(account,{client:client('2'),deadline:Date.now()+20000})).toEqual({processed:1,complete:true});
    expect(ranges).toEqual(['1','1']);expect(await db('messages').where({message_id:'<checkpoint-test@example.com>'})).toHaveLength(1);expect((await db('mailbox_checkpoints').first()).uid_validity).toBe('2');
  });

  it('clears previous freshness for a new UID generation until sorted backlog processing completes',async()=>{
    const actual=await vi.importActual<any>('../server/engine/mail.js');
    await db('mailbox_checkpoints').insert({id:uuid(),account_id:account.id,folder:'INBOX',uid_validity:'old',last_uid:100,updated_at:date()});
    const source=(uid:number)=>Buffer.from(`From: ${contact.email}\r\nTo: ${account.email}\r\nMessage-ID: <backlog-${uid}@example.com>\r\n\r\nMessage ${uid}`),fetched:number[]=[];
    const client=(uids:number[])=>({mailbox:{uidValidity:'new',uidNext:4},on:vi.fn(),connect:vi.fn(),getMailboxLock:async()=>({release:vi.fn()}),search:async()=>uids,fetch:async function*(){for(const uid of uids)yield {uid,size:200,envelope:{}};},fetchOne:async(uid:number)=>{fetched.push(uid);return {source:source(uid)};},logout:vi.fn(),close:vi.fn()});
    const incomplete=await actual.syncMailbox(account,{client:client([3,2,1]),maxMessages:2,deadline:Date.now()+20000});expect(incomplete.complete).toBe(false);expect(fetched).toEqual([1,2]);expect((await db('email_accounts').where({id:account.id}).first()).last_sync_at).toBeNull();expect(Number((await db('mailbox_checkpoints').first()).last_uid)).toBe(2);
    const complete=await actual.syncMailbox(account,{client:client([3]),maxMessages:2,deadline:Date.now()+20000});expect(complete.complete).toBe(true);expect((await db('email_accounts').where({id:account.id}).first()).last_sync_at).toBeTruthy();expect(fetched).toEqual([1,2,3]);
  });
});
