import { z } from 'zod';
import { config } from './config.js';
import { db, json } from './db.js';
import { contactSchema, insertContact } from './contacts.js';
import { audit, HttpError, id, normalizeEmail, sha256 } from './lib/util.js';
import { secureEqual } from './lib/crypto.js';
import { up } from './migrations/003_website_leads.js';

const WEBSITE = 'https://sandiegowebsiteexperts.com';
const collections = ['form-submissions', 'appointments'] as const;
export const websiteLeadSchema = z.object({
  event_id:z.string().regex(/^(form-submissions|appointments):[a-zA-Z0-9_-]{1,100}$/),
  name:z.string().trim().min(2).max(200), email:z.string().trim().email().max(254).transform(normalizeEmail),
  phone:z.string().max(60).default(''), website:z.string().url().max(2048).optional(),
  message:z.string().max(10000).default(''), form_type:z.string().max(100),
  page:z.string().max(500).default(''), page_context:z.string().max(2000).default(''),
  project_type:z.string().max(200).default(''), budget:z.string().max(200).default(''),
  booking:z.string().max(1000).default(''), created_at:z.string().datetime(),
}).strict();
export type WebsiteLead = z.infer<typeof websiteLeadSchema>;
let storage:Promise<void>|undefined;
export async function ensureWebsiteLeads() {
  if (!storage) storage=up(db).catch(error=>{storage=undefined;throw error;});
  await storage;
}
export function authorizeWebsiteLead(authorization:string|undefined) {
  if(config.websiteLeadsSecret.length<32)throw new HttpError(503,'Website integration is not configured.');
  if(!secureEqual(authorization||'','Bearer '+config.websiteLeadsSecret))throw new HttpError(401,'Unauthorized website submission.');
}

/** One immutable inquiry note per event; repeat visitors keep their CRM history and consent. */
export async function receiveWebsiteLead(input:unknown) {
  const lead=websiteLeadSchema.parse(input);
  if(lead.website&&!/^https?:$/.test(new URL(lead.website).protocol))throw new HttpError(400,'Invalid website URL.');
  await ensureWebsiteLeads();
  return db.transaction(async trx=>{
    await trx('business_settings').where({id:'agency'}).forUpdate().first();
    const receiptId=sha256(lead.event_id), existing=await trx('website_lead_receipts').where({id:receiptId}).first();
    if(existing)return {ok:true,contact_id:existing.contact_id,duplicate:true};
    const owner=await trx('users').where({role:'owner',disabled:false}).orderBy('created_at').first();
    if(!owner)throw new HttpError(503,'An active CRM owner is required.');
    const [first_name,...rest]=lead.name.split(/\s+/),last_name=rest.join(' ');
    const source=(WEBSITE+(lead.page.startsWith('/')&&!lead.page.startsWith('//')?lead.page:'')).slice(0,500);
    let contact=await trx('contacts').where({email:lead.email}).forUpdate().first();
    const suppressed=await trx('suppressions').where({email:lead.email}).first();
    if(!contact){
      const stage=await trx('pipeline_stages').where({kind:'open'}).orderBy('position').first();
      contact=await insertContact(contactSchema.parse({email:lead.email,first_name,last_name,phone:lead.phone,website:lead.website||'',source,
        tags:['Website lead'],owner_id:owner.id,stage_id:stage?.id||null,consent_status:'unknown'}),owner.id,trx);
    }else{
      // Anonymous repeat inquiries must never overwrite an operator's stage, owner, or consent.
      const additions:Record<string,unknown>={updated_at:new Date()};
      for(const [key,value]of Object.entries({first_name,last_name,phone:lead.phone,website:lead.website||''}))if(!contact[key]&&value)additions[key]=value;
      additions.tags=JSON.stringify([...new Set([...json<string[]>(contact.tags,[]),'Website lead'])]);
      await trx('contacts').where({id:contact.id}).update(additions);
    }
    const body=[`Website inquiry — ${lead.form_type}`,`Submitted: ${lead.created_at}`,`Name: ${lead.name}`,`Email: ${lead.email}`,
      lead.phone&&`Phone: ${lead.phone}`,lead.website&&`Website: ${lead.website}`,`Source: ${source}`,
      lead.project_type&&`Service: ${lead.project_type}`,lead.budget&&`Budget: ${lead.budget}`,lead.booking&&`Booking: ${lead.booking}`,
      lead.page_context&&`Attribution: ${lead.page_context}`,lead.message&&`Message:\n${lead.message}`,
      suppressed&&'Existing suppression remains in effect.'].filter(Boolean).join('\n\n');
    await trx('notes').insert({id:id(),contact_id:contact.id,user_id:owner.id,body,created_at:new Date()});
    await trx('website_lead_receipts').insert({id:receiptId,contact_id:contact.id,created_at:new Date()});
    await audit(null,'website_inquiry_received','contact',contact.id,{form_type:lead.form_type,event_id:lead.event_id},trx);
    return {ok:true,contact_id:contact.id,duplicate:false};
  });
}

/** Recovery pull uses persisted cursors; immediate webhooks and pulls share event receipts. */
export async function syncWebsiteLeads() {
  if(!config.websiteLeadsUrl||config.websiteLeadsSecret.length<32)return {enabled:false,processed:0};
  const endpoint=new URL(config.websiteLeadsUrl);
  if(endpoint.origin!==WEBSITE||endpoint.pathname!=='/api/crm/leads'||endpoint.search||endpoint.hash||endpoint.username||endpoint.password)throw new Error('Invalid website lead source.');
  await ensureWebsiteLeads();
  await db('website_sync_state').insert({id:'agency-website',data:JSON.stringify({since:new Date(Date.now()-5*60*1000).toISOString(),cursors:{}}),updated_at:new Date()}).onConflict('id').ignore();
  let processed=0;
  // Network reads happen outside transactions. Concurrent ticks replay safely, never move cursors backwards.
  const state=json<{since:string;cursors:Record<string,number>}>((await db('website_sync_state').where({id:'agency-website'}).first()).data,{since:new Date().toISOString(),cursors:{}});
  for(const collection of collections){
    const after=state.cursors[collection]||0,url=new URL(endpoint);
    url.search=new URLSearchParams({collection,after:String(after),since:state.since}).toString();
    const response=await fetch(url,{headers:{authorization:'Bearer '+config.websiteLeadsSecret},redirect:'error',signal:AbortSignal.timeout(2500),cache:'no-store'});
    if(!response.ok)throw new Error('Website lead source is unavailable.');
    const text=await response.text();if(Buffer.byteLength(text)>512*1024)throw new Error('Website lead batch is too large.');
    const batch=z.object({items:z.array(z.object({cursor:z.number().int().positive(),lead:websiteLeadSchema}).strict()).max(20)}).strict().parse(JSON.parse(text));
    let cursor=after;
    for(const item of batch.items){
      if(item.cursor<=cursor||item.lead.event_id!==`${collection}:${item.cursor}`)throw new Error('Invalid website lead cursor.');
      await receiveWebsiteLead(item.lead);cursor=item.cursor;processed++;
    }
    if(cursor>after)await db.transaction(async trx=>{
      const row=await trx('website_sync_state').where({id:'agency-website'}).forUpdate().first();
      const current=json<typeof state>(row.data,state);current.cursors[collection]=Math.max(current.cursors[collection]||0,cursor);
      await trx('website_sync_state').where({id:row.id}).update({data:JSON.stringify(current),updated_at:new Date()});
    });
  }
  return {enabled:true,processed};
}
