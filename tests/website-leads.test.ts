import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { db } from '../server/db.js';
import { config } from '../server/config.js';
import { createApp } from '../server/app.js';
import { up } from '../server/migrations/001_initial.js';
import { ensureWebsiteLeads, receiveWebsiteLead, syncWebsiteLeads } from '../server/website-leads.js';
import { defaultSettings } from '../server/settings.js';
import { id } from '../server/lib/util.js';

const enabled=process.env.RUN_DB_TESTS==='true'&&Boolean(process.env.DB_NAME?.endsWith('_test'));
describe.skipIf(!enabled)('website inquiries on isolated MariaDB, no mail',()=>{
  const salt=id().slice(0,8),owner=id(),stage=id(),email=`web-${salt}@example.test`,event=`form-submissions:${Date.now()}`;
  const input={event_id:event,name:'Jamie Website',email,phone:'+16195550123',message:'Please build a website.',form_type:'homepage',page:'/',page_context:'utm_source=google',project_type:'Website design',created_at:new Date().toISOString()};
  let sendJobsBefore=0;
  beforeAll(async()=>{
    config.encryptionKey=Buffer.alloc(32,7).toString('base64');config.schedulerSecret='test-only-'+ 's'.repeat(40);config.liveSendEnabled=false;config.websiteLeadsSecret='website-test-only-'+ 'x'.repeat(40);config.websiteLeadsUrl='';
    if(!await db.schema.hasTable('users'))await up(db);
    await db('business_settings').insert({id:'agency',data:JSON.stringify(defaultSettings),updated_at:new Date()}).onConflict('id').ignore();
    await db('users').insert({id:owner,name:'Website Test Owner',email:`owner-${salt}@example.test`,role:'owner',password_hash:'unused',permissions:'[]',disabled:false,created_at:new Date(),updated_at:new Date()});
    await db('pipeline_stages').insert({id:stage,name:'Website test leads',position:-100,kind:'open'});
    await ensureWebsiteLeads();
    sendJobsBefore=Number((await db('jobs').where({kind:'send'}).count({total:'*'}).first())?.total||0);
  });
  afterAll(async()=>{vi.restoreAllMocks();await db.destroy();});
  it('refuses anonymous/wrong-key requests and rejects consent injection before mutation',async()=>{
    const app=createApp();
    expect((await request(app).post('/integrations/website/leads').send(input)).status).toBe(401);
    expect((await request(app).post('/integrations/website/leads').set('Authorization','Bearer wrong').send(input)).status).toBe(401);
    expect((await request(app).post('/integrations/website/leads').set('Authorization','Bearer '+config.websiteLeadsSecret).send({...input,consent_status:'opted_in'})).status).toBe(400);
    expect(await db('contacts').where({email})).toHaveLength(0);
  });
  it('creates a Prospect with default open stage, owner, inquiry note and unknown consent',async()=>{
    const response=await request(createApp()).post('/integrations/website/leads').set('Authorization','Bearer '+config.websiteLeadsSecret).send(input);
    expect(response.status).toBe(201);expect(response.headers['cache-control']).toBe('no-store');
    const contact=await db('contacts').where({email}).first();
    expect(contact).toMatchObject({first_name:'Jamie',last_name:'Website',phone:input.phone,source:'https://sandiegowebsiteexperts.com/',stage_id:stage,consent_status:'unknown'});
    expect(contact.owner_id).toBeTruthy();expect((await db('notes').where({contact_id:contact.id}).first()).body).toContain(input.message);
    expect(await db('enrollments').where({contact_id:contact.id})).toHaveLength(0);
    expect(await db('jobs').where({kind:'send'})).toHaveLength(sendJobsBefore);
  });
  it('deduplicates concurrent webhook/recovery retries while retaining distinct repeat inquiries',async()=>{
    const results=await Promise.all([receiveWebsiteLead(input),receiveWebsiteLead(input)]);
    expect(results.every(r=>r.duplicate)).toBe(true);
    const contact=await db('contacts').where({email}).first();expect(await db('notes').where({contact_id:contact.id})).toHaveLength(1);
    await db('contacts').where({id:contact.id}).update({consent_status:'revoked',phone:'Operator value'});
    await db('suppressions').insert({id:id(),email,reason:'do_not_contact',source:'test',created_at:new Date()});
    await receiveWebsiteLead({...input,event_id:`appointments:${Date.now()}`,form_type:'appointment',phone:'Changed inquiry phone'});
    expect(await db('contacts').where({email})).toHaveLength(1);
    expect(await db('notes').where({contact_id:contact.id})).toHaveLength(2);
    expect(await db('contacts').where({id:contact.id}).first()).toMatchObject({consent_status:'revoked',phone:'Operator value',stage_id:stage});
    expect(await db('suppressions').where({email})).toHaveLength(1);
  });
  it('recovers persisted inquiries, retries safely after network failure and advances durable cursors',async()=>{
    config.websiteLeadsUrl='https://sandiegowebsiteexperts.com/api/crm/leads';
    await db('website_sync_state').where({id:'agency-website'}).delete();
    const cursor=Date.now(),recovered={...input,event_id:`form-submissions:${cursor}`,email:`recovered-${salt}@example.test`};
    const network=vi.spyOn(globalThis,'fetch').mockRejectedValueOnce(new Error('offline'));
    await expect(syncWebsiteLeads()).rejects.toThrow('offline');
    network.mockImplementation(async(url,options)=>{
      expect(options?.headers).toMatchObject({authorization:'Bearer '+config.websiteLeadsSecret});
      const query=new URL(String(url)).searchParams;
      const items=query.get('collection')==='form-submissions'&&Number(query.get('after'))<cursor?[{cursor,lead:recovered}]:[];
      return new Response(JSON.stringify({items}),{status:200});
    });
    expect(await syncWebsiteLeads()).toEqual({enabled:true,processed:1});
    expect(await syncWebsiteLeads()).toEqual({enabled:true,processed:0});
    expect(await db('contacts').where({email:recovered.email})).toHaveLength(1);
    network.mockRestore();config.websiteLeadsUrl='';
  });
  it('rejects unsupported source URLs without sending the integration key',async()=>{
    config.websiteLeadsUrl='https://untrusted.example/api/crm/leads';const network=vi.spyOn(globalThis,'fetch');
    await expect(syncWebsiteLeads()).rejects.toThrow('Invalid website lead source');expect(network).not.toHaveBeenCalled();network.mockRestore();config.websiteLeadsUrl='';
  });
});
