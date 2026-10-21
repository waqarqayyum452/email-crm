import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { randomBytes, randomUUID } from 'node:crypto';

const fake=vi.hoisted(()=>({syncMailbox:vi.fn(),smtpTransport:vi.fn()}));
vi.mock('../server/engine/mail.js',async importOriginal=>({
  ...await importOriginal<any>(),syncMailbox:fake.syncMailbox,smtpTransport:fake.smtpTransport,
}));
import { db } from '../server/db.js';
import { config } from '../server/config.js';
import { createApp } from '../server/app.js';
import { up } from '../server/migrations/001_initial.js';
import { defaultSettings, getSettings } from '../server/settings.js';
import { activateLiveInbox, liveInboxStatus } from '../server/lib/live-inbox.js';
import { sha256 } from '../server/lib/util.js';
import { claimJob } from '../server/worker.js';

const enabled=process.env.RUN_DB_TESTS==='true'&&Boolean(process.env.DB_NAME?.endsWith('_test'));
const tables=['audit_logs','tracking_events','tracked_links','tracking_tokens','mailbox_checkpoints','messages','send_attempt_events','send_attempts','jobs','enrollments','sequence_steps','campaign_versions','campaigns','templates','import_results','imports','suppressions','tasks','notes','deals','contact_consents','contacts','email_accounts','sessions','users','rate_limits'];
const id=()=>randomUUID(),now=()=>new Date();
const app=createApp();
let account:any,owner:{cookie:string;csrf:string},member:{cookie:string;csrf:string};

async function insertAccount(){
  const row={id:id(),label:'Isolated Inbox mailbox',email:`mailbox-${id()}@example.test`,smtp_host:'smtp.example.test',smtp_port:465,smtp_security:'tls',smtp_username:'private-fixture-user',smtp_secret:'private-fixture-secret',imap_host:'imap.example.test',imap_port:993,imap_security:'tls',imap_username:'private-fixture-user',imap_secret:'private-fixture-secret',status:'active',verified_at:now(),last_sync_at:now(),last_successful_sync_at:now(),created_at:now(),updated_at:now()};
  await db('email_accounts').insert(row);return row;
}
async function session(role:'owner'|'member'){
  const userId=id(),token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
  await db('users').insert({id:userId,name:'Isolated '+role,email:`${role}-${id()}@example.test`,password_hash:'unused-session-fixture',role,permissions:'[]',disabled:false,created_at:now(),updated_at:now()});
  await db('sessions').insert({id:id(),user_id:userId,token_hash:sha256(token),csrf_token:csrf,created_at:now(),expires_at:new Date(Date.now()+3600000)});
  return {cookie:'sdwe_session='+token,csrf};
}
async function job(extra:any={}){
  const row={id:id(),kind:'send',account_id:account.id,status:'queued',payload:JSON.stringify({is_manual:true,manual_recipient:'person@example.test',content:{subject:'Personal fixture',body_text:'private-fixture-body'}}),due_at:now(),attempts:0,created_at:now(),updated_at:now(),...extra};
  await db('jobs').insert(row);return row;
}
async function outbound(status:string,jobStatus:string){
  const queued=await job({status:jobStatus}),attemptId=id(),messageId=`<${id()}@example.test>`,acceptedAt=status==='accepted'?now():null;
  await db('send_attempts').insert({id:attemptId,job_id:queued.id,account_id:account.id,message_id:messageId,recipient:'person@example.test',status,retryable:false,reserved_at:now(),submitted_at:now(),accepted_at:acceptedAt,created_at:now()});
  const message={id:id(),account_id:account.id,attempt_id:attemptId,direction:'outbound',message_id:messageId,references_json:'[]',from_email:account.email,to_email:'person@example.test',subject:'Personal fixture',body_text:'private-fixture-body',classification:'outbound',received_at:now(),created_at:now()};
  await db('messages').insert(message);return {job:queued,attemptId,message};
}

describe.skipIf(!enabled)('live Inbox cutover and authenticated status APIs on isolated MySQL/MariaDB',()=>{
  const previous={live:config.liveSendEnabled,key:config.encryptionKey,secret:config.schedulerSecret};
  beforeAll(async()=>{if(!await db.schema.hasTable('users'))await up(db);config.encryptionKey=Buffer.alloc(32,7).toString('base64');config.schedulerSecret='isolated-inbox-'+ 's'.repeat(40);});
  afterAll(async()=>{config.liveSendEnabled=previous.live;config.encryptionKey=previous.key;config.schedulerSecret=previous.secret;await db.destroy();});
  beforeEach(async()=>{
    for(const table of tables)await db(table).delete();await db('worker_state').where({id:'inbox-live-cutover-v1'}).delete();
    await db('worker_state').where({id:'scheduler'}).update({last_heartbeat:null,last_error:null,updated_at:now()});
    await db('business_settings').where({id:'agency'}).update({data:JSON.stringify({...defaultSettings,paused:true,poll_interval_seconds:300}),updated_at:now()});
    config.liveSendEnabled=false;fake.syncMailbox.mockReset().mockResolvedValue({processed:0,complete:true});fake.smtpTransport.mockReset().mockImplementation(()=>{throw new Error('No test may create a real SMTP transport');});
    account=await insertAccount();owner=await session('owner');member=await session('member');
  });

  it('holds all old queued mail once, preserves sync/unknown work, and leaves later messages usable',async()=>{
    config.liveSendEnabled=true;
    const manual=await job(),automated=await job({payload:'{}'}),sync=await job({kind:'sync',status:'leased',payload:'{}',lease_owner:id(),lease_until:new Date(Date.now()+60000)}),unknown=await outbound('unknown','held');
    const results=await Promise.all([activateLiveInbox(),activateLiveInbox()]);
    expect(results.filter(result=>!result.already_activated)).toHaveLength(1);
    expect(results.find(result=>!result.already_activated)).toMatchObject({held_existing_jobs:2});
    for(const queued of [manual,automated])expect((await db('jobs').where({id:queued.id}).first()).status).toBe('held');
    expect((await db('jobs').where({id:sync.id}).first()).status).toBe('leased');
    expect((await db('send_attempts').where({id:unknown.attemptId}).first()).status).toBe('unknown');
    expect(await getSettings()).toMatchObject({paused:false,poll_interval_seconds:60});expect(await db('audit_logs').where({action:'inbox.live_activated'})).toHaveLength(1);
    const later=await job();expect(await activateLiveInbox()).toMatchObject({already_activated:true});expect((await db('jobs').where({id:later.id}).first()).status).toBe('queued');
  });

  it('rejects activation while live sending is disabled without changing queue or settings',async()=>{
    const old=await job();await expect(activateLiveInbox()).rejects.toMatchObject({status:409});
    expect((await db('jobs').where({id:old.id}).first()).status).toBe('queued');expect(await getSettings()).toMatchObject({paused:true,poll_interval_seconds:300});expect(await db('worker_state').where({id:'inbox-live-cutover-v1'})).toHaveLength(0);expect(await db('audit_logs').where({action:'inbox.live_activated'})).toHaveLength(0);
  });

  it('rejects activation atomically if a send lease is active',async()=>{
    config.liveSendEnabled=true;const queued=await job(),leased=await job({status:'leased',lease_owner:id(),lease_until:new Date(Date.now()+60000)});
    await expect(activateLiveInbox()).rejects.toMatchObject({status:409});
    expect((await db('jobs').where({id:queued.id}).first()).status).toBe('queued');expect((await db('jobs').where({id:leased.id}).first()).status).toBe('leased');expect(await getSettings()).toMatchObject({paused:true,poll_interval_seconds:300});expect(await db('worker_state').where({id:'inbox-live-cutover-v1'})).toHaveLength(0);
  });

  it('never activates with an old message newly leased by a competing Inbox worker',async()=>{
    config.liveSendEnabled=true;
    for(let run=0;run<6;run++){
      await db('jobs').delete();await db('worker_state').where({id:'inbox-live-cutover-v1'}).delete();await db('business_settings').where({id:'agency'}).update({data:JSON.stringify({...defaultSettings,paused:true})});
      const old=await job(),[activation,claim]=await Promise.allSettled([activateLiveInbox(),claimJob(id(),false,true)]);
      expect(claim.status).toBe('fulfilled');const persisted=await db('jobs').where({id:old.id}).first();
      if(activation.status==='fulfilled'){
        expect(persisted.status).toBe('held');expect(claim.status==='fulfilled'?claim.value:null).toBeNull();expect(await getSettings()).toMatchObject({paused:false});
      }else{
        expect(activation.reason).toMatchObject({status:409});expect(persisted.status).toBe('leased');expect(await getSettings()).toMatchObject({paused:true});expect(await db('worker_state').where({id:'inbox-live-cutover-v1'})).toHaveLength(0);
      }
    }
    expect(fake.smtpTransport).not.toHaveBeenCalled();expect(await db('send_attempts')).toHaveLength(0);
  });

  it('keeps scheduler diagnostics private and returns only counters and mailbox health',async()=>{
    await job();await db('email_accounts').where({id:account.id}).update({last_error:'private-fixture-error-secret'});
    expect((await request(app).post('/internal/tick').send({action:'status'})).status).toBe(401);
    const status=await request(app).post('/internal/tick').set('Authorization','Bearer '+config.schedulerSecret).send({action:'status'});expect(status.status).toBe(200);expect(status.body).toMatchObject({live_send_enabled:false,paused:true,poll_interval_seconds:300,accounts:[{id:account.id,has_error:true}],jobs:[{kind:'send',status:'queued',count:1}]});
    const serialized=JSON.stringify(status.body);for(const sensitive of ['private-fixture',account.email,'smtp_secret','imap_secret','body_text','payload'])expect(serialized).not.toContain(sensitive);
    expect(await liveInboxStatus()).toMatchObject({unknown_attempts:0});
  });

  it('requires session, CSRF and Inbox permission to process, and rejects arbitrary worker scope',async()=>{
    const anonymous=request.agent(app);expect((await anonymous.get('/api/inbox/outbox')).status).toBe(401);
    expect((await request(app).post('/api/inbox/process').set('Cookie',owner.cookie).send({mode:'sync'})).status).toBe(403);
    const pre=await anonymous.get('/api/auth/session');expect((await anonymous.post('/api/inbox/process').set('x-csrf-token',pre.body.csrfToken).send({mode:'sync'})).status).toBe(401);
    expect((await request(app).post('/api/inbox/process').set('Cookie',member.cookie).set('x-csrf-token',member.csrf).send({mode:'sync'})).status).toBe(403);
    for(const command of [{mode:'all'},{mode:'sync',maxJobs:100}])expect((await request(app).post('/api/inbox/process').set('Cookie',owner.cookie).set('x-csrf-token',owner.csrf).send(command)).status).toBe(400);
    const queued=await job(),automated=await job({payload:'{}'});
    const sync=await request(app).post('/api/inbox/process').set('Cookie',owner.cookie).set('x-csrf-token',owner.csrf).send({mode:'sync'});expect(sync.status,sync.body.error).toBe(200);expect(fake.syncMailbox).toHaveBeenCalledTimes(1);expect(await db('send_attempts')).toHaveLength(0);expect((await db('jobs').where({id:queued.id}).first()).due_at).toEqual(queued.due_at);
    await db('business_settings').where({id:'agency'}).update({data:JSON.stringify({...defaultSettings,paused:false})});
    const inbox=await request(app).post('/api/inbox/process').set('Cookie',owner.cookie).set('x-csrf-token',owner.csrf).send({mode:'inbox'});expect(inbox.status,inbox.body.error).toBe(200);expect((await db('jobs').where({id:queued.id}).first()).last_error).toContain('disabled');expect((await db('jobs').where({id:automated.id}).first()).last_error).toBeNull();expect(fake.smtpTransport).not.toHaveBeenCalled();expect(await db('send_attempts')).toHaveLength(0);
  });

  it('shows only pending manual Inbox jobs for the selected mailbox without raw payload or message body',async()=>{
    const pending=await job(),leased=await job({status:'leased'});await job({status:'held'});await job({status:'failed'});await job({status:'completed'});await job({payload:'{}'});await job({payload:JSON.stringify({is_manual:'true',manual_recipient:'not-manual@example.test'})});
    const other=await insertAccount();await job({account_id:other.id});
    const outbox=await request(app).get('/api/inbox/outbox').set('Cookie',owner.cookie).query({account_id:account.id});expect(outbox.status).toBe(200);expect(outbox.body.items).toHaveLength(4);expect(outbox.body.items.find((item:any)=>item.id===leased.id).status).toBe('sending');expect(outbox.body.items.find((item:any)=>item.id===pending.id)).toMatchObject({recipient:'person@example.test',subject:'Personal fixture',status:'queued'});
    expect(JSON.stringify(outbox.body)).not.toContain('private-fixture-body');expect(outbox.body.items.every((item:any)=>!('payload'in item))).toBe(true);
    expect((await request(app).get('/api/inbox/outbox?account_id=not-an-id').set('Cookie',owner.cookie)).status).toBe(400);
  });

  it('reports SMTP acceptance, held unknown outcomes, active submission and retry queue state in lists and threads',async()=>{
    const fixtures=await Promise.all([outbound('accepted','completed'),outbound('unknown','held'),outbound('submitting','leased'),outbound('temporary','queued')]);
    const listed=await request(app).get('/api/inbox').set('Cookie',owner.cookie);expect(listed.status).toBe(200);
    for(const [index,status] of ['accepted','held','sending','queued'].entries())expect(listed.body.items.find((item:any)=>item.id===fixtures[index].message.id).send_status).toBe(status);
    const detail=await request(app).get('/api/inbox/'+fixtures[0].message.id).set('Cookie',owner.cookie);expect(detail.status).toBe(200);expect(detail.body.send_status).toBe('accepted');expect(detail.body.accepted_at).toBeTruthy();expect(detail.body.thread).toHaveLength(4);expect(new Set(detail.body.thread.map((message:any)=>message.send_status))).toEqual(new Set(['accepted','held','sending','queued']));
  });
});
