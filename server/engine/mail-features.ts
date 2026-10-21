import { z } from 'zod';
import { db, json, type Database } from '../db.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import { HttpError, id } from '../lib/util.js';
import { escapeHtml, sanitizeEmail } from './content.js';
import { up } from '../migrations/002_mail_features.js';

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
let provision: Promise<void> | undefined;
// New releases can provision these two additive tables before starting mail work.
// The same definition is available through the normal versioned migration CLI.
export async function ensureMailFeatures() {
  if (!provision) provision = up(db).catch(error => { provision = undefined; throw error; });
  return provision;
}
export const filename = (value: string) => value.replace(/[\\/\x00-\x1f\x7f]/g, '_').replace(/^\.+/, '').trim().slice(0, 180) || 'attachment';
const attachmentSchema = z.object({ filename: z.string().min(1).max(180), content_type: z.string().regex(/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/).max(100), content_base64: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) }).strict();
export type MailFile = { id: string; filename: string; content_type: string; size: number; encrypted_content?: string; unavailable?: boolean };
export function encryptAttachments(value: unknown): MailFile[] {
  const files = z.array(attachmentSchema).max(MAX_ATTACHMENTS).parse(value || []);
  let total = 0;
  return files.map(file => {
    if (!file.content_base64 || file.content_base64.length%4!==0 || /[^A-Za-z0-9+/=]/.test(file.content_base64)) throw new HttpError(400, 'Attachment data is invalid.');
    const bytes = Buffer.from(file.content_base64, 'base64');
    if (bytes.toString('base64') !== file.content_base64) throw new HttpError(400, 'Attachment data is invalid.');
    total += bytes.length;
    if (total > MAX_ATTACHMENT_BYTES) throw new HttpError(400, 'Attachments must total 5 MB or less.');
    return { id: id(), filename: filename(file.filename), content_type: file.content_type, size: bytes.length, encrypted_content: encryptSecret(file.content_base64) };
  });
}
export const safeFiles = (value: unknown) => json<MailFile[]>(value, []).map(({ encrypted_content, ...file }) => file);
export function smtpAttachments(files: MailFile[]) {
  return files.filter(file => file.encrypted_content).map(file => ({ filename: filename(file.filename), contentType: file.content_type, contentDisposition: 'attachment' as const, content: Buffer.from(decryptSecret(file.encrypted_content!), 'base64') }));
}
export function incomingAttachments(parsed: any): MailFile[] {
  let total = 0;
  return (parsed.attachments || []).slice(0, MAX_ATTACHMENTS).map((file: any) => {
    const bytes = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content || '');
    total += bytes.length;
    return { id: id(), filename: filename(String(file.filename || 'attachment')), content_type: String(file.contentType || 'application/octet-stream').slice(0, 100), size: Number(file.size || bytes.length),
      ...(bytes.length && total <= MAX_ATTACHMENT_BYTES ? { encrypted_content: encryptSecret(bytes.toString('base64')) } : { unavailable: true }) };
  });
}
export const manualContentSchema = z.object({
  body_text: z.string().trim().min(1).max(100000), body_html: z.string().max(200000).transform(value=>sanitizeEmail(value)).optional(),
  include_signature: z.boolean().optional(), signature: z.string().max(10000).optional(),
  open_tracking: z.boolean().optional(), attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS).optional(),
  draft_id: z.string().uuid().optional(),
});
export function manualContent(body: z.infer<typeof manualContentSchema>, settings: any) {
  const signature = body.include_signature ? String(body.signature ?? settings.signature ?? '').trim() : '';
  const body_text = body.body_text + (signature ? '\n\n' + signature : '');
  const html = body.body_html ? sanitizeEmail(body.body_html) : null;
  return { body_text, body_html: html ? html + (signature ? '<p>' + escapeHtml(signature).replace(/\n/g, '<br>') + '</p>' : '') : null };
}
export async function saveMessageDetails(message: any, metadata: { from_name?: string; to_name?: string; attachments?: MailFile[] }, trx: Database = db) {
  await trx('message_details').insert({ message_id: message.id, from_name: String(metadata.from_name || '').replace(/[\x00-\x1f]/g, '').slice(0, 200), to_name: String(metadata.to_name || '').replace(/[\x00-\x1f]/g, '').slice(0, 200), attachments: JSON.stringify(metadata.attachments || []), attachment_manifest:JSON.stringify(safeFiles(metadata.attachments||[])), created_at: new Date() }).onConflict('message_id').ignore();
}
export async function enrichMail(messages: any[]) {
  if (!messages.length) return messages;
  const ids = messages.map(message => message.latest_message_id || message.id);
  const details = await db('message_details').whereIn('message_id', ids).select('message_id','from_name','to_name','attachment_manifest');
  const byId = new Map(details.map(item => [item.message_id, item]));
  const addresses = [...new Set(messages.flatMap(message => [message.from_email, message.to_email]).filter(Boolean))];
  const knownNames=await db('message_details as d').join('messages as m','m.id','d.message_id').whereIn('m.from_email',addresses).whereNot('d.from_name','').orderBy('d.created_at','desc').limit(2000).select('m.from_email','d.from_name');
  const contacts = await db('contacts').whereIn('email', addresses).select('email', 'first_name', 'last_name');
  const names = new Map<string,string>();
  for(const row of knownNames)if(!names.has(row.from_email))names.set(row.from_email,row.from_name);
  for(const contact of contacts){const name=[contact.first_name,contact.last_name].filter(Boolean).join(' ');if(name)names.set(contact.email,name);}
  const settings = await (await import('../settings.js')).getSettings();
  const accounts = await db('email_accounts').select('email', 'sender_name');
  for (const account of accounts) names.set(account.email, account.sender_name || settings.sender_name);
  const opens = await db('tracking_events').whereIn('message_id', ids).where({ kind: 'open' }).modify(q => { if (settings.filter_bots) q.where({ bot: false }); }).select('message_id').min({ first_opened_at: 'created_at' }).max({ last_opened_at: 'created_at' }).count({ open_count: '*' }).groupBy('message_id');
  const byOpen = new Map<string,any>(opens.map((item:any) => [item.message_id, item]));
  return messages.map(message => {
    const detail = byId.get(message.latest_message_id || message.id), engagement = byOpen.get(message.latest_message_id || message.id);
    return { ...message, from_name: names.get(message.from_email) || detail?.from_name || '', to_name: names.get(message.to_email) || detail?.to_name || '', attachments: safeFiles(detail?.attachment_manifest),
      open_count: Number(engagement?.open_count || 0), first_opened_at: engagement?.first_opened_at || null, last_opened_at: engagement?.last_opened_at || null };
  });
}
