import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID, randomBytes } from 'node:crypto';
import { db } from '../server/db.js';
import { config } from '../server/config.js';
import { createApp } from '../server/app.js';
import { up } from '../server/migrations/001_initial.js';
import { sha256 } from '../server/lib/util.js';

const enabled=process.env.RUN_DB_TESTS==='true'&&/_test$/.test(process.env.DB_NAME||'');
describe.skipIf(!enabled)('CRM Inbox/Sent/Spam folders on isolated MariaDB, no sending',()=>{
  const app=createApp(),accountId=randomUUID(),root=randomUUID(),incoming=randomUUID(),sent=randomUUID(),pending=randomUUID(),uncertain=randomUUID();
  let owner:any,reader:any,acceptedAttempt='',unknownJob='';
  const now=new Date(),address=accountId+'@example.test';
  async function session(role:string){const id=randomUUID(),token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');await db('users').insert({id,name:'Folder QA',email:id+'@example.test',password_hash:'unused',role,permissions:'[]',disabled:false,created_at:now,updated_at:now});await db('sessions').insert({id:randomUUID(),user_id:id,token_hash:sha256(token),csrf_token:csrf,created_at:now,expires_at:new Date(Date.now()+3600000)});return {cookie:'sdwe_session='+token,csrf};}
  const get=(folder:string)=>request(app).get('/api/inbox').query({account_id:accountId,folder}).set('Cookie',owner.cookie);
  const move=(id:string,folder:string,user=owner)=>request(app).post('/api/inbox/'+id+'/folder').set('Cookie',user.cookie).set('x-csrf-token',user.csrf).send({folder});
  const inbound=(id:string)=>({id,account_id:accountId,direction:'inbound',from_email:'person@example.test',to_email:address,message_id:'<'+id+'@example.test>',references_json:'[]',subject:'Folder fixture',body_text:'No SMTP used',classification:'unmatched',received_at:now,created_at:now});
  beforeAll(async()=>{
    config.liveSendEnabled=false;config.encryptionKey=Buffer.alloc(32,6).toString('base64');config.schedulerSecret='folder-fixture-only-'+ 'x'.repeat(40);
    if(!await db.schema.hasTable('users'))await up(db);owner=await session('owner');reader=await session('member');
    await db('email_accounts').insert({id:accountId,label:'Folder tests',email:address,smtp_host:'smtp.example.test',smtp_port:465,smtp_security:'tls',smtp_username:'unused',imap_host:'imap.example.test',imap_port:993,imap_username:'unused',status:'inactive',created_at:now,updated_at:now});
    await db('messages').insert([inbound(root),inbound(incoming)]);
    for(const [messageId,status] of [[sent,'accepted'],[pending,'reserved'],[uncertain,'unknown']]){
      const jobId=randomUUID(),attemptId=randomUUID();await db('jobs').insert({id:jobId,kind:'send',account_id:accountId,payload:'{}',status:status==='accepted'?'completed':status==='unknown'?'held':'queued',due_at:now,created_at:now,updated_at:now});
      await db('send_attempts').insert({id:attemptId,job_id:jobId,account_id:accountId,message_id:'<'+messageId+'@example.test>',recipient:'person@example.test',status,reserved_at:now,accepted_at:status==='accepted'?now:null,created_at:now});
      await db('messages').insert({...inbound(messageId),direction:'outbound',from_email:address,to_email:'person@example.test',classification:'outbound',attempt_id:attemptId,in_reply_to:messageId===sent?'<'+root+'@example.test>':null,created_at:new Date(now.getTime()+1000),received_at:new Date(now.getTime()+1000)});
      if(status==='accepted')acceptedAttempt=attemptId;if(status==='unknown')unknownJob=jobId;
    }
  });
  afterAll(async()=>{await db.destroy();});
  it('Sent requires SMTP acceptance and retains incoming replies in their conversation',async()=>{
    const sentView=await get('sent');expect(sentView.status,sentView.body.error).toBe(200);expect(sentView.body.items.map((item:any)=>item.id)).toEqual([root]);expect(sentView.body.items[0].message_count).toBe(2);
    expect(sentView.body.counts).toMatchObject({inbox:2,sent:1,spam:0});
    expect(sentView.body.unread_counts).toEqual({inbox:2,sent:1,spam:0});
    expect((await get('inbox')).body.items.map((item:any)=>item.id).sort()).toEqual([root,incoming].sort());
    expect((await get('spam')).body.items).toHaveLength(0);expect((await get('all')).body.items).toHaveLength(4);
  });
  it('moves whole conversations, keeps later replies in Spam and restores without touching delivery state',async()=>{
    expect((await move(sent,'spam')).status).toBe(200);expect((await move(root,'spam')).status).toBe(200);
    expect((await get('sent')).body.items).toHaveLength(0);expect((await get('inbox')).body.items.map((item:any)=>item.id)).toEqual([incoming]);
    expect((await get('spam')).body.items[0]).toMatchObject({id:root,message_count:2,is_spam:true});
    const later=randomUUID();await db('messages').insert({...inbound(later),in_reply_to:'<'+sent+'@example.test>',created_at:new Date(now.getTime()+2000),received_at:new Date(now.getTime()+2000)});
    expect((await get('spam')).body.items[0]).toMatchObject({id:root,message_count:3,is_spam:true});
    expect((await move(later,'inbox')).status).toBe(200);expect((await get('spam')).body.items).toHaveLength(0);expect((await get('sent')).body.items[0].message_count).toBe(3);
    expect((await db('send_attempts').where({id:acceptedAttempt}).first()).status).toBe('accepted');expect((await db('jobs').where({id:unknownJob}).first()).status).toBe('held');
    expect(await db('audit_logs').where({action:'inbox.folder_changed',entity_id:root})).toHaveLength(3);
  });
  it('requires authentication, CSRF and Inbox permission for folder changes',async()=>{
    expect((await request(app).post('/api/inbox/'+root+'/folder').set('Cookie',owner.cookie).send({folder:'spam'})).status).toBe(403);
    expect((await move(root,'spam',reader)).status).toBe(403);
    const anonymous=request.agent(app),pre=await anonymous.get('/api/auth/session');expect((await anonymous.post('/api/inbox/'+root+'/folder').set('x-csrf-token',pre.body.csrfToken).send({folder:'spam'})).status).toBe(401);
    expect((await move(root,'sent')).status).toBe(400);expect((await move(randomUUID(),'spam')).status).toBe(404);
    expect((await get('invalid')).status).toBe(400);
  });
  it('counts only personally unread conversations across folders, and new replies restore the badge',async()=>{
    const detail=await request(app).get('/api/inbox/'+root).set('Cookie',owner.cookie);
    expect((await request(app).post('/api/inbox/'+root+'/read').set('Cookie',owner.cookie).set('x-csrf-token',owner.csrf).send({message_ids:detail.body.thread.map((message:any)=>message.id)})).status).toBe(200);
    expect((await get('inbox')).body.unread_counts).toEqual({inbox:1,sent:0,spam:0});
    expect((await get('sent')).body.items).toHaveLength(1);
    expect((await get('sent')).body.counts.sent).toBe(1);
    const other=await request(app).get('/api/inbox').query({folder:'sent',account_id:accountId}).set('Cookie',reader.cookie);
    expect(other.body.unread_counts).toEqual({inbox:2,sent:1,spam:0});
    await move(root,'spam');expect((await get('spam')).body.unread_counts).toEqual({inbox:1,sent:0,spam:0});
    const later=randomUUID();await db('messages').insert({...inbound(later),in_reply_to:'<'+sent+'@example.test>',created_at:new Date(now.getTime()+3000),received_at:new Date(now.getTime()+3000)});
    expect((await get('inbox')).body.unread_counts).toEqual({inbox:1,sent:0,spam:1});
    await move(root,'inbox');expect((await get('sent')).body.unread_counts).toEqual({inbox:2,sent:1,spam:0});
  });
});
