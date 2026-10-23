import { z } from 'zod';
import { Router } from './http.js';
import { requireUser, permit } from './auth.js';
import { db, json } from './db.js';
import { encryptSecret, decryptSecret } from './lib/crypto.js';
import { id, HttpError } from './lib/util.js';
import { ensureMailFeatures, manualContentSchema, encryptMailFiles, rasterType, filename, type MailFile } from './engine/mail-features.js';

export const mailToolsRouter = Router();
mailToolsRouter.use(requireUser, async (_req, _res, next) => { await ensureMailFeatures(); next(); });
const draftSchema = manualContentSchema.partial().extend({ body_text:z.string().max(100000).optional(),account_id: z.string().uuid().or(z.literal('')).optional(), to: z.string().max(254).optional(), subject: z.string().max(998).optional(), reply_id: z.string().uuid().optional() }).strict();
const summary=(data:z.infer<typeof draftSchema>)=>encryptSecret(JSON.stringify({to:data.to,subject:data.subject,account_id:data.account_id,reply_id:data.reply_id}));
mailToolsRouter.get('/drafts', async (req, res) => {
  const rows = await db('mail_drafts').where({ user_id: req.user!.id }).select('id','summary','updated_at').orderBy('updated_at', 'desc').limit(50);
  res.json({ items: rows.map(row => { const data = JSON.parse(decryptSecret(row.summary)); return { ...data,id: row.id, updated_at: row.updated_at, to: data.to || '', subject: data.subject || '(No subject)' }; }) });
});
mailToolsRouter.get('/drafts/:id', async (req, res) => {
  const row = await db('mail_drafts').where({ id: req.params.id, user_id: req.user!.id }).first();
  if (!row) throw new HttpError(404, 'Draft not found.');
  res.json({ ...JSON.parse(decryptSecret(row.encrypted_content)), id: row.id, updated_at: row.updated_at });
});
mailToolsRouter.post('/drafts', permit('inbox:write'), async (req, res) => {
  const content = draftSchema.parse(req.body), draftId = id();
  encryptMailFiles(content.attachments,content.inline_images);
  await db.transaction(async trx=>{await trx('users').where({id:req.user!.id}).forUpdate().first();if(Number((await trx('mail_drafts').where({user_id:req.user!.id}).count({n:'*'}).first())?.n)>=50)throw new HttpError(400,'You can keep up to 50 drafts. Discard an old draft first.');await trx('mail_drafts').insert({ id: draftId, user_id: req.user!.id, encrypted_content: encryptSecret(JSON.stringify(content)),summary:summary(content), updated_at: new Date() });});
  res.status(201).json({ id: draftId });
});
mailToolsRouter.patch('/drafts/:id', permit('inbox:write'), async (req, res) => {
  // A strict operation field supports discard without adding a second HTTP verb.
  if (req.body?.discard === true && Object.keys(req.body).length === 1) {
    await db('mail_drafts').where({ id: req.params.id, user_id: req.user!.id }).delete(); res.json({ discarded: true }); return;
  }
  const content = draftSchema.parse(req.body);
  encryptMailFiles(content.attachments,content.inline_images);
  if (!await db('mail_drafts').where({ id: req.params.id, user_id: req.user!.id }).update({ encrypted_content: encryptSecret(JSON.stringify(content)),summary:summary(content), updated_at: new Date() })) throw new HttpError(404, 'Draft not found.');
  res.json({ id: req.params.id });
});
mailToolsRouter.get('/:id/attachments/:fileId', async (req, res) => {
  const row = await db('message_details').where({ message_id: req.params.id }).first();
  const file = json<MailFile[]>(row?.attachments, []).find(file => file.id === req.params.fileId);
  if (!file?.encrypted_content) throw new HttpError(404, 'Attachment is unavailable. Open the original email in webmail.');
  const name = filename(file.filename);
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name.replace(/[^a-zA-Z0-9._ -]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()]/g, value => '%' + value.charCodeAt(0).toString(16))}`, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" }).send(Buffer.from(decryptSecret(file.encrypted_content), 'base64'));
});

mailToolsRouter.get('/:id/inline/:fileId',async(req,res)=>{
  const row=await db('message_details').where({message_id:req.params.id}).first();
  const file=json<MailFile[]>(row?.attachments,[]).find(file=>file.id===req.params.fileId&&file.disposition==='inline');
  if(!file?.encrypted_content)throw new HttpError(404,'Inline image is unavailable.');
  const bytes=Buffer.from(decryptSecret(file.encrypted_content),'base64'),type=rasterType(bytes);
  if(!type||type!==file.content_type)throw new HttpError(404,'Inline image is unavailable.');
  res.set({'Content-Type':type,'Content-Disposition':'inline','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}).send(bytes);
});
