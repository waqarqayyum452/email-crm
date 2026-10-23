import { sanitizeFormattedEmail } from '../lib/html.js';
import { DateTime } from 'luxon';

export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

export function mergeFields(text: string, contact: Record<string, any>, html = false): string {
  const values = { ...contact, ...(typeof contact.custom_fields === 'object' ? contact.custom_fields : {}) };
  const missing = new Set<string>();
  const result = text.replace(/{{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*(?:\|([^{}]*))?}}/g, (_all, key, fallback) => {
    const v = values[key] == null || String(values[key]).trim() === '' ? fallback : values[key];
    if (v == null || String(v).trim() === '') { missing.add(key); return ''; }
    return html ? escapeHtml(v) : String(v);
  });
  if (missing.size) throw new Error(`Missing personalization: ${[...missing].join(', ')}`);
  if (/{{|}}/.test(result)) throw new Error('Invalid or unresolved personalization placeholder');
  return result;
}

export function safeDestination(value: string): string | null {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}

export function sanitizeEmail(html: string, allowImages = false, rewrite?: (url:string)=>string): string {
  return sanitizeFormattedEmail(html,allowImages?'stored':'none',undefined,rewrite);
}

export function renderStep(step: any, contact: any) {
  const subject = mergeFields(step.subject, contact).replace(/[\r\n]/g, ' ');
  const body_text = mergeFields(step.body_text, contact);
  const body_html = step.body_html ? sanitizeEmail(mergeFields(step.body_html, contact, true)) : null;
  return { subject, body_text, body_html };
}

export interface WindowSettings { timezone: string; sending_days: number[]; sending_start: string; sending_end: string; }
export function nextSendingTime(now: Date, settings: WindowSettings): Date {
  let local = DateTime.fromJSDate(now, {zone:settings.timezone});
  if (!local.isValid || !settings.sending_days.length) throw new Error('Invalid sending timezone or days');
  const [sh,sm] = settings.sending_start.split(':').map(Number);
  const [eh,em] = settings.sending_end.split(':').map(Number);
  for (let i=0;i<15;i++) {
    // Construct wall-clock boundaries for every date, so DST changes retain local hours.
    const start = local.startOf('day').set({hour:sh,minute:sm});
    const end = local.startOf('day').set({hour:eh,minute:em});
    if (settings.sending_days.includes(local.weekday) && start < end && local < end) return (local < start ? start : local).toUTC().toJSDate();
    local = local.plus({days:1}).startOf('day');
  }
  throw new Error('No valid sending window in the next two weeks');
}

export function followupTime(acceptedAt: Date, delayDays: number, settings: WindowSettings) {
  const local = DateTime.fromJSDate(acceptedAt, {zone:settings.timezone}).plus({days:delayDays});
  return nextSendingTime(local.toUTC().toJSDate(), settings);
}

export type Outcome = 'temporary'|'permanent'|'auth'|'limit'|'unknown';
export function smtpFailure(error: any, options: {submissionStarted?:boolean} = {}): {status: Outcome; retryable: boolean; code: string; message: string} {
  const code = String(error?.code || 'SMTP_ERROR').slice(0,80);
  const response = Number(error?.responseCode || 0);
  const command = String(error?.command || '').toUpperCase();
  // Nodemailer may label a post-DATA disconnect ECONNECTION/CONN. Once sendMail
  // has started, only an explicit negative SMTP response proves rejection.
  if(options.submissionStarted&&!(response>=400&&response<=599))return {status:'unknown',retryable:false,code,message:'SMTP acceptance is unknown. Held for manual reconciliation; automatic retry is disabled.'};
  if (code === 'EAUTH' || response === 535 || response === 534) return {status:'auth',retryable:false,code,message:'Mailbox authentication failed. Update credentials and validate the account.'};
  if (response === 421 || response === 452 || response === 454) return {status:'limit',retryable:false,code,message:'Provider temporarily restricted sending. Review provider limits before retrying.'};
  if (response >= 500 && response <= 599) return {status:'permanent',retryable:false,code,message:`SMTP rejected the message (${response}).`};
  if (response >= 400 && response <= 499) return {status:'temporary',retryable:true,code,message:`SMTP temporarily rejected the message (${response}).`};
  // Once DATA may have been transmitted, disconnects cannot prove non-acceptance.
  if (['CONN','EHLO','HELO','STARTTLS','AUTH','MAIL FROM','RCPT TO'].includes(command)) return {status:'temporary',retryable:true,code,message:'Connection failed before message submission.'};
  return {status:'unknown',retryable:false,code,message:'SMTP acceptance is unknown. Held for manual reconciliation; automatic retry is disabled.'};
}

export function classifyIncoming(parsed: any): 'human_reply'|'automatic'|'delivery_failure'|'unmatched'|'uncertain' {
  const headers = parsed.headers || new Map();
  const get = (key:string) => String(headers.get(key) || '').toLowerCase();
  const rawType=headers.get('content-type');
  const ct=typeof rawType==='object'&&rawType?String(rawType.value||'').toLowerCase()+'; report-type='+String(rawType.params?.['report-type']||'').toLowerCase():get('content-type');
  if (ct.includes('report-type=delivery-status') || ct.includes('delivery-status') || (parsed.attachments||[]).some((a:any)=>a.contentType==='message/delivery-status')) return 'delivery_failure';
  if (/^(?:mailer-daemon|postmaster)@/i.test(parsed.from?.value?.[0]?.address || '')) return 'uncertain';
  if ((get('auto-submitted') && get('auto-submitted') !== 'no') || get('x-autoreply') || get('x-autorespond') || ['bulk','list','junk','auto_reply'].includes(get('precedence'))) return 'automatic';
  if (!parsed.from?.value?.[0]?.address) return 'uncertain';
  return 'human_reply';
}

/** DSN status is scoped to its recipient block; never combine different recipients. */
export function deliveryReports(parsed:any): {recipient:string;status:string;action:string}[] {
  const texts=[String(parsed.text||''),...(parsed.attachments||[]).filter((a:any)=>a.contentType==='message/delivery-status').map((a:any)=>a.content?.toString('utf8')||'')];
  const reports:{recipient:string;status:string;action:string}[]=[];
  for(const text of texts)for(const block of text.replace(/\r?\n[ \t]+/g,' ').split(/\r?\n[ \t]*\r?\n/)){
    const recipient=block.match(/^(?:Final|Original)-Recipient:\s*[^;\r\n]+;\s*([^\s<>]+)/im)?.[1]?.toLowerCase();
    const status=block.match(/^Status:\s*([245]\.\d{1,3}\.\d{1,3})/im)?.[1];
    if(recipient&&status)reports.push({recipient,status,action:block.match(/^Action:\s*([^\s]+)/im)?.[1]?.toLowerCase()||''});
  }
  return reports;
}

export function referenceIds(parsed: any): string[] {
  return [...new Set([parsed.inReplyTo, ...(Array.isArray(parsed.references) ? parsed.references : typeof parsed.references === 'string' ? parsed.references.match(/<[^>]+>/g) || [] : [])].filter(Boolean).map(String))];
}

export function checkpointRange(checkpoint: any, uidValidity: string): number {
  return checkpoint && String(checkpoint.uid_validity) === uidValidity ? Number(checkpoint.last_uid) + 1 : 1;
}

export function botLike(userAgent: string): boolean { return /bot|crawler|spider|scanner|headless|proofpoint|mimecast|barracuda|safelinks/i.test(userAgent); }
