import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { randomUUID, randomBytes } from 'node:crypto';
const fake=vi.hoisted(()=>({sendMail:vi.fn(),syncMailbox:vi.fn()}));
vi.mock('../server/engine/mail.js',async original=>({...await original<any>(),smtpTransport:async()=>({sendMail:fake.sendMail,close:vi.fn()}),syncMailbox:fake.syncMailbox}));
import { config } from '../server/config.js';
import { db, json } from '../server/db.js';
import { createApp } from '../server/app.js';
import { up } from '../server/migrations/001_initial.js';
import { ensureMailFeatures, encryptAttachments, filename, MAX_ATTACHMENT_BYTES } from '../server/engine/mail-features.js';
import { ingestIncoming } from '../server/engine/mail.js';
import { claimJob, reserveSend, runWorker } from '../server/worker.js';
import { defaultSettings } from '../server/settings.js';
import { sha256 } from '../server/lib/util.js';
import { decryptSecret } from '../server/lib/crypto.js';

const enabled=process.env.RUN_DB_TESTS==='true'&&Boolean(process.env.DB_NAME?.endsWith('_test'));
const app=createApp(),uuid=()=>randomUUID();
const file={filename:'proposal.pdf',content_type:'application/pdf',content_base64:Buffer.from('%PDF-1.4 isolated proposal').toString('base64')};
const tables=['audit_logs','tracking_events','tracked_links','tracking_tokens','mailbox_checkpoints','messages','send_attempt_events','send_attempts','jobs','enrollments','sequence_steps','campaign_versions','campaigns','templates','import_results','imports','suppressions','tasks','notes','deals','contact_consents','contacts','email_accounts','sessions','users','rate_limits'];
let account:any,owner:any,other:any;
async function login(){const userId=uuid(),token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');await db('users').insert({id:userId,name:'Test Owner',email:`${userId}@example.test`,password_hash:'unused',role:'owner',permissions:'[]',disabled:false,created_at:new Date(),updated_at:new Date()});await db('sessions').insert({id:uuid(),user_id:userId,token_hash:sha256(token),csrf_token:csrf,created_at:new Date(),expires_at:new Date(Date.now()+3600000)});return {id:userId,cookie:'sdwe_session='+token,csrf};}
const post=(path:string,data:any,user=owner)=>request(app).post('/api/inbox'+path).set('Cookie',user.cookie).set('x-csrf-token',user.csrf).send(data);
const get=(path:string,user=owner)=>request(app).get('/api/inbox'+path).set('Cookie',user.cookie);

describe('mail attachments input',()=>{
  beforeAll(()=>{config.encryptionKey=Buffer.alloc(32,4).toString('base64');});
  it('rejects paths, URLs, invalid base64 and oversized totals, and sanitizes filenames',()=>{
    expect(()=>encryptAttachments([{...file,path:'C:/private.txt'}])).toThrow();
    expect(()=>encryptAttachments([{...file,content_base64:'https://internal/secret'}])).toThrow();
    expect(()=>encryptAttachments([{...file,content_base64:'AA=A'}])).toThrow();
    expect(()=>encryptAttachments(Array.from({length:11},()=>file))).toThrow();
    expect(()=>encryptAttachments([{...file,content_base64:Buffer.alloc(MAX_ATTACHMENT_BYTES).toString('base64')},file])).toThrow('5 MB');
    expect(filename('../proposal\r\n.pdf')).toBe('_proposal__.pdf');
    const [stored]=encryptAttachments([file]);expect(JSON.stringify(stored)).not.toContain(file.content_base64);expect(decryptSecret(stored.encrypted_content!)).toBe(file.content_base64);
  });
});

describe.skipIf(!enabled)('mail experience on isolated MariaDB with fake SMTP',()=>{
  const oldLive=config.liveSendEnabled;
  beforeAll(async()=>{if(!await db.schema.hasTable('users'))await up(db);await ensureMailFeatures();config.encryptionKey=Buffer.alloc(32,4).toString('base64');config.schedulerSecret='isolated-mail-features-'+ 's'.repeat(40);config.liveSendEnabled=true;});
  afterAll(async()=>{config.liveSendEnabled=oldLive;await db.destroy();});
  beforeEach(async()=>{
    for(const table of tables)await db(table).delete();owner=await login();other=await login();
    const now=new Date();account={id:uuid(),label:'Mail feature fixture',email:`mailbox-${uuid()}@example.test`,sender_name:'Agency Team',smtp_host:'smtp.example.test',smtp_port:465,smtp_security:'tls',smtp_username:'fixture',smtp_secret:'not-used',imap_host:'imap.example.test',imap_port:993,imap_security:'tls',imap_username:'fixture',imap_secret:'not-used',status:'active',provider_policy:'opt_in_only',verified_at:now,last_sync_at:now,created_at:now,updated_at:now};await db('email_accounts').insert(account);
    await db('business_settings').where({id:'agency'}).update({data:JSON.stringify({...defaultSettings,paused:false,signature:'Agency signature\nhttps://example.test',filter_bots:true})});fake.sendMail.mockReset().mockImplementation(async(mail:any)=>({accepted:[mail.to]}));fake.syncMailbox.mockReset().mockResolvedValue({processed:0,complete:true});
  });
  it('sends sanitized formatted content, signature, immutable attachments and an opt-in tracking pixel',async()=>{
    const queued=await post('/compose',{account_id:account.id,to:'person@example.test',subject:'Proposal',body_text:'Hello person',body_html:'<p><strong>Hello</strong> person<script>bad()</script><img src="https://bad.test/pixel"></p>',attachments:[file],include_signature:true,open_tracking:true});expect(queued.status,queued.body.error).toBe(202);
    const job=await db('jobs').where({id:queued.body.job_id}).first();expect(JSON.stringify(job.payload)).not.toContain(file.content_base64);
    await runWorker({maxJobs:5,inboxOnly:true,budgetMs:20000});expect(fake.sendMail).toHaveBeenCalledTimes(1);
    const sent=fake.sendMail.mock.calls[0][0];expect(sent.text).toContain('Agency signature');expect(sent.html).toContain('<strong>Hello</strong>');expect(sent.html).not.toMatch(/script|bad\.test/);expect(sent.html).toMatch(/\/t\/open\/[a-f0-9]{64}\.gif/);expect(sent.attachments[0]).toMatchObject({filename:'proposal.pdf',contentType:'application/pdf'});expect(sent.attachments[0].content.toString()).toBe('%PDF-1.4 isolated proposal');
    const message=await db('messages').where({attempt_id:(await db('send_attempts').where({job_id:job.id}).first()).id}).first();
    const detail=await get('/'+message.id);expect(detail.status).toBe(200);expect(detail.body.thread[0]).toMatchObject({from_name:'Agency Team',open_tracking:1,open_count:0,attachments:[{filename:'proposal.pdf'}]});expect(JSON.stringify(detail.body)).not.toContain('encrypted_content');expect(JSON.stringify(detail.body)).not.toContain('/t/open/');
    const token=await db('tracking_tokens').where({message_id:message.id,kind:'tracking'}).first();expect((await request(app).get('/t/open/'+token.id+'.gif').set('User-Agent','normal-email-client')).status).toBe(200);
    expect((await get('/'+message.id)).body.thread[0]).toMatchObject({open_count:1});
    const listed=await get('');expect(listed.body.items[0]).toMatchObject({open_count:1,from_name:'Agency Team'});
  });
  it('keeps tracking off when omitted and preserves attachment content and tracking token on safe retries',async()=>{
    const queued=await post('/compose',{account_id:account.id,to:'person@example.test',subject:'Retry',body_text:'A note',attachments:[file],open_tracking:true});
    const job=await claimJob(uuid(),false,true);expect(job.id).toBe(queued.body.job_id);const first=await reserveSend(job);const token=await db('tracking_tokens').where({message_id:first!.message.id,kind:'tracking'}).first();
    await db('jobs').where({id:job.id}).update({status:'queued',due_at:new Date(),lease_owner:null,lease_until:null});const next=await reserveSend(await claimJob(uuid(),false,true));expect(next!.message.message_id).toBe(first!.message.message_id);expect(next!.attachments[0].content.equals(first!.attachments[0].content)).toBe(true);expect(await db('tracking_tokens').where({message_id:first!.message.id})).toHaveLength(1);expect(next!.message.body_html).toContain(token.id);
    const plain=await post('/compose',{account_id:account.id,to:'plain@example.test',subject:'Plain',body_text:'Plain content'});await db('jobs').where({id:job.id}).update({status:'held'});const prepared=await reserveSend(await claimJob(uuid(),false,true));expect(prepared!.job.id).toBe(plain.body.job_id);expect(await db('tracking_tokens').where({message_id:prepared!.message.id})).toHaveLength(0);expect(prepared!.message.body_text).toBe('Plain content');
  });
  it('receives sender names and encrypted attachments, protects downloads, and never renders document HTML',async()=>{
    const now=new Date(),parsed={messageId:`<${uuid()}@example.test>`,from:{value:[{address:'jane@example.test',name:'Jane Smith'}]},subject:'Document',text:'See attached',date:now,headers:new Map(),attachments:[{filename:'invoice.html',contentType:'text/html',content:Buffer.from('<script>not executed</script>')}]};
    const incoming=await db.transaction(trx=>ingestIncoming(account,parsed,1,'1',trx));const detail=await get('/'+incoming.message.id);expect(detail.body.thread[0]).toMatchObject({from_name:'Jane Smith',attachments:[{filename:'invoice.html'}]});const stored=await db('message_details').where({message_id:incoming.message.id}).first();expect(stored.attachments).not.toContain('not executed');
    const url='/api/inbox/'+incoming.message.id+'/attachments/'+detail.body.thread[0].attachments[0].id;expect((await request(app).get(url)).status).toBe(401);const download=await request(app).get(url).set('Cookie',owner.cookie);expect(download.headers['content-type']).toBe('application/octet-stream');expect(download.headers['content-disposition']).toContain('attachment;');expect(download.headers['content-security-policy']).toContain('sandbox');expect(download.body.toString()).toBe('<script>not executed</script>');
    const later=await db.transaction(trx=>ingestIncoming(account,{...parsed,messageId:`<${uuid()}@example.test>`,from:{value:[{address:'jane@example.test'}]},attachments:[]},2,'1',trx));expect((await get('/'+later.message.id)).body.thread[0].from_name).toBe('Jane Smith');
  });
  it('saves private encrypted drafts, enforces ownership/CSRF, resumes and removes the draft atomically on send',async()=>{
    const data={account_id:account.id,to:'draft@example.test',subject:'Private draft subject',body_text:'Private draft content',attachments:[file],body_html:'<b>Private draft</b><script>bad()</script>'};const saved=await post('/drafts',data);expect(saved.status).toBe(201);
    const row=await db('mail_drafts').where({id:saved.body.id}).first();expect(row.encrypted_content).not.toContain('Private draft');expect(row.summary).not.toContain('Private draft');expect((await get('/drafts/'+saved.body.id,other)).status).toBe(404);expect((await get('/drafts',other)).body.items).toHaveLength(0);
    const resumed=await get('/drafts/'+saved.body.id);expect(resumed.body.body_text).toBe(data.body_text);expect(resumed.body.body_html).not.toContain('script');expect((await get('/drafts')).body.items[0]).toMatchObject({subject:data.subject});expect(JSON.stringify((await get('/drafts')).body)).not.toContain(file.content_base64);
    expect((await request(app).patch('/api/inbox/drafts/'+saved.body.id).set('Cookie',owner.cookie).send(data)).status).toBe(403);
    const sent=await post('/compose',{...data,draft_id:saved.body.id});expect(sent.status).toBe(202);expect(await db('mail_drafts').where({id:saved.body.id})).toHaveLength(0);
  });
  it('retains suppression and anchored reply gates with formatted attachments',async()=>{
    await db('suppressions').insert({id:uuid(),email:'blocked@example.test',reason:'manual',source:'fixture',created_at:new Date()});expect((await post('/compose',{account_id:account.id,to:'blocked@example.test',subject:'Blocked',body_text:'Content',attachments:[file]})).status).toBe(400);
    const incoming=await db.transaction(trx=>ingestIncoming(account,{messageId:`<${uuid()}@example.test>`,from:{value:[{address:'person@example.test',name:'Person'}]},text:'Hello',subject:'Original',headers:new Map()},2,'1',trx));
    const queued=await post('/'+incoming.message.id+'/reply',{body_text:'Reply',body_html:'<b>Reply</b>',attachments:[file],include_signature:true,open_tracking:true});expect(queued.status).toBe(202);const payload=json((await db('jobs').where({id:queued.body.job_id}).first()).payload,{});expect(payload).toMatchObject({reply_source_id:incoming.message.id,in_reply_to:incoming.message.message_id,manual_recipient:'person@example.test'});
    await db('messages').where({id:incoming.message.id}).update({from_email:'changed@example.test'});await runWorker({maxJobs:5,budgetMs:20000,inboxOnly:true});expect(fake.sendMail).not.toHaveBeenCalled();expect((await db('jobs').where({id:queued.body.job_id}).first()).status).toBe('cancelled');
  });
});
