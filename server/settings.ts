import { Router } from './http.js';
import { z } from 'zod';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { DateTime } from 'luxon';
import { db, json, type Database } from './db.js';
import { requireUser, permit, consumeRateLimit } from './auth.js';
import { encryptSecret, decryptSecret } from './lib/crypto.js';
import { validateMailTarget } from './lib/mail-target.js';
import { id, audit, HttpError, normalizeEmail, safeError } from './lib/util.js';
import { sanitizeEmail } from './lib/html.js';
import { ensureMailboxRemoval } from './mailbox-removal.js';
import { ensureMailboxSignatures } from './mailbox-signatures.js';

const safeUrl=z.string().max(2048).refine(v=>v===''||(/^https?:\/\//i.test(v)&&(()=>{try{return !new URL(v).username&&!new URL(v).password;}catch{return false;}})()),'Use a valid http(s) URL.');
const customField=z.object({key:z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),label:z.string().min(1).max(100),type:z.enum(['text','number','date']).default('text')});
export const settingsSchema=z.object({
  agency_name:z.string().min(1).max(200),website:safeUrl,logo_url:safeUrl,sender_name:z.string().min(1).max(150),business_address:z.string().max(1000),signature:z.string().max(10000),
  timezone:z.string().refine(v=>DateTime.now().setZone(v).isValid,'Use a valid IANA timezone.'),
  application_cap:z.number().int().min(1).max(10000),provider_cap:z.number().int().min(1).max(10000),
  sending_days:z.array(z.number().int().min(1).max(7)).min(1).max(7),sending_start:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),sending_end:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  min_interval_seconds:z.number().int().min(60).max(86400),followup_delays:z.array(z.number().int().min(1).max(365)).max(10),max_retries:z.number().int().min(0).max(5),
  poll_interval_seconds:z.number().int().min(60).max(3600),sync_stale_seconds:z.number().int().min(300).max(7200),paused:z.boolean(),open_tracking:z.boolean(),click_tracking:z.boolean(),retention_days:z.number().int().min(7).max(730),filter_bots:z.boolean(),
  categories:z.array(z.string().min(1).max(100)).max(100),tags:z.array(z.string().min(1).max(100)).max(200),custom_fields:z.array(customField).max(50),unsubscribe_copy:z.string().min(1).max(500),
}).strict().refine(s=>s.application_cap<=s.provider_cap,{message:'Application cap cannot exceed the configured provider cap.',path:['application_cap']}).refine(s=>s.sending_start<s.sending_end,{message:'Use a daytime window with start before end.',path:['sending_end']}).refine(s=>s.sync_stale_seconds>=s.poll_interval_seconds,{message:'Sync freshness must be at least the polling interval.',path:['sync_stale_seconds']}).refine(s=>![s.signature,s.business_address,s.unsubscribe_copy].some(v=>/{{|}}/.test(v)),{message:'Use static footer text. Personalization belongs in campaign content.',path:['signature']});
export const defaultSettings={agency_name:'San Diego Website Experts',website:'https://sandiegowebsiteexperts.com',logo_url:'',sender_name:'San Diego Website Experts',business_address:'',signature:'San Diego Website Experts\nhttps://sandiegowebsiteexperts.com',timezone:'America/Los_Angeles',application_cap:20,provider_cap:100,sending_days:[1,2,3,4,5],sending_start:'09:00',sending_end:'17:00',min_interval_seconds:180,followup_delays:[3,7],max_retries:3,poll_interval_seconds:60,sync_stale_seconds:900,paused:true,open_tracking:false,click_tracking:false,retention_days:90,filter_bots:true,categories:['Contractors','Remodeling companies','Landscapers','Cleaning businesses','Dental clinics'],tags:[] as string[],custom_fields:[] as z.infer<typeof customField>[],unsubscribe_copy:'Unsubscribe from these emails'};
export async function getSettings(trx:Database=db) {const row=await trx('business_settings').where({id:'agency'}).first();return {...defaultSettings,...json(row?.data,{})} as typeof defaultSettings;}
export const settingsRouter=Router();settingsRouter.use(requireUser);
settingsRouter.get('/',async(_req,res)=>res.json(await getSettings()));
settingsRouter.patch('/',permit('settings:write'),async(req,res)=>{
  const result=await db.transaction(async trx=>{await trx('business_settings').where({id:'agency'}).forUpdate().first();const old=await getSettings(trx);const next=settingsSchema.parse({...old,...req.body});if(new Set(next.custom_fields.map(f=>f.key)).size!==next.custom_fields.length)throw new HttpError(400,'Custom field keys must be unique.');
    next.signature=sanitizeEmail(next.signature);await trx('business_settings').where({id:'agency'}).update({data:JSON.stringify(next),updated_at:new Date()});await audit(req.user!.id,'settings_updated','settings','agency',{changed:Object.keys(next).filter(k=>JSON.stringify((old as any)[k])!==JSON.stringify((next as any)[k]))},trx);return next;});res.json(result);
});

export function safeAccount(account:any) {const {smtp_secret,imap_secret,...safe}=account;return {...safe,is_default:!!safe.is_default,has_smtp_secret:!!smtp_secret,has_imap_secret:!!imap_secret};}
const accountSchema=z.object({signature:z.string().max(10000).nullable().default(null),label:z.string().min(1).max(150),email:z.string().email().max(254),sender_name:z.string().max(150).default(''),smtp_host:z.string().min(1).max(253),smtp_port:z.union([z.literal(465),z.literal(587)]),smtp_security:z.enum(['tls','starttls']),smtp_username:z.string().min(1).max(254),smtp_password:z.string().min(1).max(1024).optional(),imap_host:z.string().min(1).max(253),imap_port:z.literal(993),imap_security:z.literal('tls').default('tls'),imap_username:z.string().min(1).max(254),imap_password:z.string().min(1).max(1024).optional(),status:z.enum(['inactive','active','paused','error']).default('inactive'),provider_policy:z.literal('opt_in_only').default('opt_in_only')}).strict();
export const accountRouter=Router();accountRouter.use(requireUser);
accountRouter.use(async(_req,_res,next)=>{await ensureMailboxRemoval();await ensureMailboxSignatures();next();});
accountRouter.get('/',async(_req,res)=>res.json({items:(await db('email_accounts').whereNull('deleted_at').orderBy('created_at')).map(safeAccount)}));
async function saveAccount(body:any,userId:string,accountId?:string) {
  let current=accountId?await db('email_accounts').where({id:accountId}).first():null;if(accountId&&(!current||current.deleted_at))throw new HttpError(404,'Mailbox not found.');
  if(!accountId&&typeof body?.email==='string'){const removed=await db('email_accounts').where({email:normalizeEmail(body.email)}).whereNotNull('deleted_at').first();if(removed){if(!body.smtp_password||!body.imap_password)throw new HttpError(400,'Enter both mailbox passwords to reconnect this address.');current=removed;accountId=removed.id;}}
  const sanitized=current?safeAccount(current):{};const allowed=Object.keys(accountSchema.shape);const merged={...Object.fromEntries(Object.entries(sanitized).filter(([key])=>allowed.includes(key))),...body};const data=accountSchema.parse(merged);
  if((data.smtp_port===465)!==(data.smtp_security==='tls'))throw new HttpError(400,'Use implicit TLS on 465 or required STARTTLS on 587.');
  await Promise.all([validateMailTarget(data.smtp_host,data.smtp_port,'smtp'),validateMailTarget(data.imap_host,data.imap_port,'imap')]);
  // A mailbox identity cannot change once associated with history.
  if(current&&normalizeEmail(data.email)!==current.email)throw new HttpError(400,'Add a new mailbox to replace the sender. Existing sender identities are immutable.');
  const {smtp_password,imap_password,...columns}=data;
  const connectionChanged=!current||smtp_password||imap_password||['smtp_host','smtp_port','smtp_security','smtp_username','imap_host','imap_port','imap_username'].some(k=>(current as any)[k]!== (columns as any)[k]);
  const row={...columns,deleted_at:null,email:normalizeEmail(columns.email),...(smtp_password?{smtp_secret:encryptSecret(smtp_password)}:{}),...(imap_password?{imap_secret:encryptSecret(imap_password)}:{}),...(connectionChanged?{verified_at:null,status:'inactive'}:{}),updated_at:new Date()};
  if(!connectionChanged&&data.status==='active'&&!current?.verified_at)throw new HttpError(400,'Validate both SMTP and IMAP before activating this mailbox.');
  const mailboxId=accountId||id();await db.transaction(async trx=>{await trx('business_settings').where({id:'agency'}).forUpdate().first();if(current){const latest=await trx('email_accounts').where({id:mailboxId}).forUpdate().first();if(!latest||new Date(latest.updated_at).getTime()!==new Date(current.updated_at).getTime())throw new HttpError(409,'Mailbox changed while saving. Refresh and try again.');await trx('email_accounts').where({id:mailboxId}).update(row);}else await trx('email_accounts').insert({id:mailboxId,...row,is_default:!(await trx('email_accounts').whereNull('deleted_at').first()),created_at:new Date()});await audit(userId,current?'mailbox_updated':'mailbox_added','email_account',mailboxId,{label:data.label,email:data.email,connection_changed:!!connectionChanged},trx);});return safeAccount(await db('email_accounts').where({id:mailboxId}).first());
}
accountRouter.post('/',permit('settings:write'),async(req,res)=>res.status(201).json(await saveAccount(req.body,req.user!.id)));
accountRouter.patch('/:id',permit('settings:write'),async(req,res)=>res.json(await saveAccount(req.body,req.user!.id,String(req.params.id))));
accountRouter.delete('/:id',permit('settings:write'),async(req,res)=>{
  await db.transaction(async trx=>{
    await trx('business_settings').where({id:'agency'}).forUpdate().first();
    const account=await trx('email_accounts').where({id:req.params.id}).forUpdate().first();
    if(!account)throw new HttpError(404,'Mailbox not found.');
    if(account.deleted_at)return;
    // Lock the queue before clearing credentials. A claimed network operation must
    // finish (or recover safely) before the operator can disconnect its account.
    const jobs=await trx('jobs').where({account_id:account.id}).forUpdate();
    if(jobs.some(job=>job.status==='leased')||await trx('send_attempts').where({account_id:account.id,status:'submitting'}).first())throw new HttpError(409,'This mailbox is processing mail. Wait a moment and try deleting it again.');
    const now=new Date(),reason='Mailbox deleted from CRM';
    // Unknown SMTP outcomes and their held jobs remain available for reconciliation.
    const ambiguous=await trx('send_attempts').where({account_id:account.id,status:'unknown'}).select('job_id');
    const unknownJobs=ambiguous.map(attempt=>attempt.job_id);
    if(unknownJobs.length)await trx('jobs').whereIn('id',unknownJobs).update({status:'held',lease_owner:null,lease_until:null,updated_at:now});
    await trx('jobs').where({account_id:account.id}).whereIn('status',['queued','failed','held']).whereNotIn('id',unknownJobs).update({status:'cancelled',last_error:reason,lease_owner:null,lease_until:null,updated_at:now});
    await trx('send_attempts').where({account_id:account.id}).whereIn('status',['reserved','temporary','auth','limit']).update({status:'cancelled',retryable:false,error_message:reason});
    await trx('enrollments').where({account_id:account.id}).whereIn('status',['active','paused']).update({status:'stopped',stop_reason:reason,updated_at:now});
    await trx('campaigns').where({account_id:account.id}).whereIn('status',['active','scheduled']).update({status:'paused',updated_at:now});
    await trx('email_accounts').where({id:account.id}).update({deleted_at:now,status:'inactive',is_default:false,smtp_secret:null,imap_secret:null,verified_at:null,last_sync_at:null,last_error:null,updated_at:now});
    await audit(req.user!.id,'mailbox_deleted','email_account',account.id,{history_preserved:true},trx);
  });
  res.json({ok:true});
});
accountRouter.post('/:id/default',permit('settings:write'),async(req,res)=>{
  await db.transaction(async trx=>{await trx('business_settings').where({id:'agency'}).forUpdate().first();const account=await trx('email_accounts').where({id:req.params.id}).first();if(!account||account.deleted_at)throw new HttpError(404,'Mailbox not found.');if(!account.verified_at||account.status!=='active')throw new HttpError(400,'Validate and activate the mailbox before making it the default.');await trx('email_accounts').update({is_default:false,updated_at:new Date()});await trx('email_accounts').where({id:account.id}).update({is_default:true});await audit(req.user!.id,'default_mailbox_changed','email_account',account.id,{},trx);});res.json({ok:true});
});
accountRouter.post('/:id/test-connection',permit('settings:write'),async(req,res)=>{
  await consumeRateLimit('mail-test:'+req.user!.id,5,60000);
  const account=await db('email_accounts').where({id:req.params.id}).whereNull('deleted_at').first();if(!account)throw new HttpError(404,'Mailbox not found.');if(!account.smtp_secret||!account.imap_secret)throw new HttpError(400,'Save both mailbox passwords privately before validating.');
  let transport:ReturnType<typeof nodemailer.createTransport>|undefined;let imap:ImapFlow|undefined;
  try {
    const [smtpTarget,imapTarget]=await Promise.all([validateMailTarget(account.smtp_host,account.smtp_port,'smtp'),validateMailTarget(account.imap_host,account.imap_port,'imap')]);
    transport=nodemailer.createTransport({host:smtpTarget.address,port:account.smtp_port,secure:account.smtp_security==='tls',requireTLS:true,tls:{servername:account.smtp_host,rejectUnauthorized:true,minVersion:'TLSv1.2'},auth:{user:account.smtp_username,pass:decryptSecret(account.smtp_secret)},connectionTimeout:7000,greetingTimeout:7000,socketTimeout:10000,logger:false,debug:false});await transport.verify();
    imap=new ImapFlow({host:imapTarget.address,port:account.imap_port,secure:true,tls:{servername:account.imap_host,rejectUnauthorized:true,minVersion:'TLSv1.2'},auth:{user:account.imap_username,pass:decryptSecret(account.imap_secret)},logger:false,disableAutoIdle:true,connectionTimeout:7000,greetingTimeout:7000,socketTimeout:10000});
    imap.on('error',()=>{});await imap.connect();await imap.logout();
    const updated=await db('email_accounts').where({id:account.id,updated_at:account.updated_at}).update({verified_at:new Date(),last_error:null,updated_at:new Date()});if(!updated)throw new HttpError(409,'Mailbox changed during validation. Validate its current settings again.');await audit(req.user!.id,'mailbox_validated','email_account',account.id,{});res.json({ok:true,smtp:'connected',imap:'connected',message:'Credentials and TLS validated. No message was sent. Activate this account when ready.'});
  } catch(err) {if(err instanceof HttpError&&err.status===409)throw err;const error=safeError(err);await db('email_accounts').where({id:account.id,updated_at:account.updated_at}).update({last_error:error,verified_at:null,status:'error',updated_at:new Date()});throw new HttpError(400,error);}finally{transport?.close();imap?.close();}
});
