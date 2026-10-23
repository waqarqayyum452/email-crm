import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID, randomBytes } from 'node:crypto';
import { db } from '../server/db.js';
import { config } from '../server/config.js';
import { createApp } from '../server/app.js';
import { up } from '../server/migrations/001_initial.js';
import { ensureInboxReads } from '../server/engine/inbox-reads.js';
import { sha256 } from '../server/lib/util.js';

const enabled = process.env.RUN_DB_TESTS === 'true' && /_test$/.test(process.env.DB_NAME || '');
describe.skipIf(!enabled)('personal Inbox read state on isolated MariaDB, no sending', () => {
  const app = createApp(), accountId = randomUUID(), root = randomUUID(), reply = randomUUID(), otherThread = randomUUID();
  let first: any, second: any;
  async function session() {
    const id = randomUUID(), token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex'), now = new Date();
    await db('users').insert({ id, name: 'Read-only teammate', email: id+'@example.test', password_hash: 'unused', role: 'member', permissions: '[]', disabled: false, created_at: now, updated_at: now });
    await db('sessions').insert({ id: randomUUID(), user_id: id, token_hash: sha256(token), csrf_token: csrf, created_at: now, expires_at: new Date(Date.now()+3600000) });
    return { id, cookie: 'sdwe_session='+token, csrf };
  }
  const get = (path: string, user = first) => request(app).get('/api/inbox'+path).set('Cookie',user.cookie);
  const mark = (ids: string[], user = first) => request(app).post('/api/inbox/'+root+'/read').set('Cookie',user.cookie).set('x-csrf-token',user.csrf).send({message_ids:ids});
  beforeAll(async () => {
    config.liveSendEnabled = false; config.encryptionKey = Buffer.alloc(32,3).toString('base64'); config.schedulerSecret = 'read-tests-only-'+ 'x'.repeat(40);
    if (!await db.schema.hasTable('users')) await up(db);
    await ensureInboxReads(); first = await session(); second = await session(); const now = new Date();
    await db('email_accounts').insert({id:accountId,label:'Read tests',email:accountId+'@example.test',smtp_host:'smtp.example.test',smtp_port:465,smtp_security:'tls',smtp_username:'unused',imap_host:'imap.example.test',imap_port:993,imap_username:'unused',status:'inactive',created_at:now,updated_at:now});
    const base={account_id:accountId,direction:'inbound',from_email:'sender@example.test',to_email:accountId+'@example.test',references_json:'[]',subject:'Read state',body_text:'No mail is sent',classification:'unmatched',received_at:now,created_at:now};
    await db('messages').insert([{...base,id:root,message_id:'<'+root+'@example.test>'},{...base,id:reply,message_id:'<'+reply+'@example.test>',in_reply_to:'<'+root+'@example.test>',received_at:new Date(now.getTime()+1000)},{...base,id:otherThread,message_id:'<'+otherThread+'@example.test>'}]);
  });
  afterAll(async()=>{await db.destroy();});
  it('GET preserves unread messages; read acknowledgements need session and CSRF',async()=>{
    expect((await get('?account_id='+accountId)).body.items.find((item:any)=>item.id===root).unread_count).toBe(2);
    expect((await get('/'+root)).body.thread.every((item:any)=>item.is_read===false)).toBe(true);
    expect(await db('inbox_reads').where({user_id:first.id})).toHaveLength(0);
    expect((await request(app).post('/api/inbox/'+root+'/read').set('Cookie',first.cookie).send({message_ids:[root]})).status).toBe(403);
    const anonymous=request.agent(app),pre=await anonymous.get('/api/auth/session');
    expect((await anonymous.post('/api/inbox/'+root+'/read').set('x-csrf-token',pre.body.csrfToken).send({message_ids:[root]})).status).toBe(401);
  });
  it('acknowledges a displayed snapshot once per user; other teammates and later replies stay unread',async()=>{
    expect((await mark([root])).status).toBe(200);expect((await mark([root])).status).toBe(200);
    expect(await db('inbox_reads').where({user_id:first.id,message_id:root})).toHaveLength(1);
    expect((await get('?account_id='+accountId)).body.items.find((item:any)=>item.id===root).unread_count).toBe(1);
    expect((await get('?account_id='+accountId,second)).body.items.find((item:any)=>item.id===root).unread_count).toBe(2);
    expect((await mark([root,reply])).status).toBe(200);
    expect((await get('?account_id='+accountId)).body.items.find((item:any)=>item.id===root).unread_count).toBe(0);
    const later=randomUUID(),base=await db('messages').where({id:reply}).first();await db('messages').insert({...base,id:later,message_id:'<'+later+'@example.test>',references_json:JSON.stringify([]),received_at:new Date()});
    expect((await get('?account_id='+accountId)).body.items.find((item:any)=>item.id===root).unread_count).toBe(1);
    expect((await get('/'+root)).body.thread.find((item:any)=>item.id===later).is_read).toBe(false);
  });
  it('rejects cross-conversation IDs and attempts to change another user state',async()=>{
    expect((await mark([otherThread])).status).toBe(400);
    expect((await request(app).post('/api/inbox/'+root+'/read').set('Cookie',first.cookie).set('x-csrf-token',first.csrf).send({message_ids:[root],user_id:second.id})).status).toBe(400);
    expect(await db('inbox_reads').where({user_id:second.id})).toHaveLength(0);
  });
});
