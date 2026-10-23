import { Router } from './http.js';
import { z } from 'zod';
import { db, json, type Database } from './db.js';
import { requireUser, permit, consumeRateLimit } from './auth.js';
import { HttpError, id, audit, normalizeEmail } from './lib/util.js';
import { getSettings } from './settings.js';
import { renderStep, sanitizeEmail, followupTime, nextSendingTime } from './engine/content.js';
import { contactEligibility, manualRecipientEligibility, stopContact } from './engine/policy.js';
import { prepareMarketing } from './tracking.js';
import { runWorker } from './worker.js';
import { groupConversations, conversationParticipant, type ThreadMessage } from './engine/threads.js';
import { ensureMailFeatures, enrichMail, manualContentSchema, manualContent, encryptAttachments } from './engine/mail-features.js';
import { ensureInboxReads, readMessageIds } from './engine/inbox-reads.js';

const stepSchema = z.object({subject:z.string().min(1).max(998).refine(s=>!/[\r\n]/.test(s),'Subject must be one line'),body_text:z.string().min(1).max(100000),body_html:z.string().max(200000).nullable().optional(),delay_days:z.number().int().min(0).max(365).default(0)});
const draftSchema = z.object({name:z.string().trim().min(1).max(200),account_id:z.string().uuid(),steps:z.array(stepSchema).min(1).max(10),contact_ids:z.array(z.string().uuid()).max(10000).default([]),open_tracking:z.boolean().default(false),click_tracking:z.boolean().default(false),scheduled_at:z.string().datetime({offset:true}).nullable().optional()});
const templateSchema = z.object({name:z.string().trim().min(1).max(200),subject:stepSchema.shape.subject,body_text:stepSchema.shape.body_text,body_html:stepSchema.shape.body_html});
const parseContact = (c:any) => ({...c,tags:json(c.tags,[]),custom_fields:json(c.custom_fields,{})});
const publicCampaign = (c:any) => ({...c,draft:json(c.draft,{}),open_tracking:!!c.open_tracking,click_tracking:!!c.click_tracking});
async function campaignOr404(campaignId: string, trx: Database = db) { const campaign = await trx('campaigns').where({id:campaignId}).first(); if (!campaign) throw new HttpError(404,'Campaign not found.'); return campaign; }

async function audience(draft: any, account: any, trx: Database = db) {
  const included:any[] = [], excluded:any[] = [];
  const contactIds = [...new Set<string>(draft.contact_ids || [])];
  const contacts = contactIds.length ? await trx('contacts').whereIn('id',contactIds) : [];
  const byId = new Map(contacts.map(c=>[c.id,c]));
  for (const contactId of contactIds) {
    const raw = byId.get(contactId), contact = raw ? parseContact(raw) : null;
    let reason = await contactEligibility(contact,account,trx);
    if (!reason) try { for (const step of draft.steps) renderStep(step,contact); } catch(error) { reason = (error as Error).message; }
    (reason ? excluded : included).push({id:contactId,email:contact?.email || '',company_name:contact?.company_name || '',reason});
  }
  return {included,excluded};
}

async function publish(campaign: any, draft: any, actorId: string, trx: Database) {
  const latest = await trx('campaign_versions').where({campaign_id:campaign.id}).max({number:'number'}).first();
  const versionId = id(), number = Number(latest?.number || 0) + 1;
  const snapshot = {...draft,account_id:campaign.account_id,steps:draft.steps.map((s:any,i:number)=>({...s,body_html:s.body_html?sanitizeEmail(s.body_html):null,delay_days:i===0?0:s.delay_days}))};
  await trx('campaign_versions').insert({id:versionId,campaign_id:campaign.id,number,snapshot:JSON.stringify(snapshot),created_by:actorId,created_at:new Date()});
  await trx('sequence_steps').insert(snapshot.steps.map((s:any,position:number)=>({id:id(),version_id:versionId,position,...s})));
  return {id:versionId,number,snapshot};
}

export const campaignRouter = Router();
campaignRouter.use(requireUser);
campaignRouter.get('/',async(_req,res)=>{
  const accepted=db('send_attempts').select('campaign_id').count({accepted:'id'}).where({status:'accepted',is_test:false}).groupBy('campaign_id').as('accepted_totals');
  const replies=db('messages').select('campaign_id').count({human_replies:'id'}).where({direction:'inbound',classification:'human_reply',is_test:false}).groupBy('campaign_id').as('reply_totals');
  const rows=await db('campaigns as c').leftJoin('email_accounts as a','a.id','c.account_id').leftJoin(accepted,'accepted_totals.campaign_id','c.id').leftJoin(replies,'reply_totals.campaign_id','c.id').select('c.*','a.email as account_email',db.raw('COALESCE(accepted_totals.accepted,0) as accepted'),db.raw('COALESCE(reply_totals.human_replies,0) as human_replies')).orderBy('c.created_at','desc');
  res.json({items:rows.map(c=>({...publicCampaign(c),accepted:Number(c.accepted),human_replies:Number(c.human_replies)}))});
});
campaignRouter.post('/',permit('campaigns:write'),async(req,res)=>{
  const draft=draftSchema.parse(req.body), account=await db('email_accounts').where({id:draft.account_id}).first();
  if (!account) throw new HttpError(400,'Select a mailbox.');
  const campaign={id:id(),name:draft.name,account_id:draft.account_id,status:'draft',draft:JSON.stringify(draft),scheduled_at:draft.scheduled_at?new Date(draft.scheduled_at):null,open_tracking:draft.open_tracking,click_tracking:draft.click_tracking,created_by:req.user!.id,created_at:new Date(),updated_at:new Date()};
  await db.transaction(async trx=>{await trx('campaigns').insert(campaign);await audit(req.user!.id,'campaign.created','campaign',campaign.id,{name:draft.name},trx);});
  res.status(201).json(publicCampaign(campaign));
});
campaignRouter.get('/:id',async(req,res)=>{
  const campaign=await campaignOr404(String(req.params.id)),draft=json(campaign.draft,{}),account=await db('email_accounts').where({id:campaign.account_id}).first();
  const published=campaign.version_id?await db('campaign_versions').where({id:campaign.version_id}).first():null;
  const enrollments=await db('enrollments').where({campaign_id:campaign.id});
  const versions=await db('campaign_versions').where({campaign_id:campaign.id}).select('id','number','created_at').orderBy('number','desc');
  const accepted=await db('send_attempts').where({campaign_id:campaign.id,status:'accepted',is_test:false}).count({count:'id'}).first(),replies=await db('messages').where({campaign_id:campaign.id,direction:'inbound',classification:'human_reply',is_test:false}).count({count:'id'}).first();
  res.json({...publicCampaign(campaign),account_email:account.email,accepted:Number(accepted?.count||0),human_replies:Number(replies?.count||0),steps:published?json(published.snapshot,{}).steps:draft.steps,audience:await audience(draft,account),enrollments,versions,history:await db('audit_logs').where({entity_type:'campaign',entity_id:campaign.id}).orderBy('created_at','desc').limit(100)});
});
campaignRouter.patch('/:id',permit('campaigns:write'),async(req,res)=>{
  const result=await db.transaction(async trx=>{
    const c=await trx('campaigns').where({id:req.params.id}).forUpdate().first();if(!c)throw new HttpError(404,'Campaign not found.');
    if(c.status!=='draft')throw new HttpError(409,'Published campaigns require the explicit revise action.');
    const draft=draftSchema.parse({...json<any>(c.draft,{}),...req.body});
    if(!await trx('email_accounts').where({id:draft.account_id}).first())throw new HttpError(400,'Mailbox not found.');
    await trx('campaigns').where({id:c.id}).update({name:draft.name,account_id:draft.account_id,draft:JSON.stringify(draft),scheduled_at:draft.scheduled_at?new Date(draft.scheduled_at):null,open_tracking:draft.open_tracking,click_tracking:draft.click_tracking,updated_at:new Date()});
    await audit(req.user!.id,'campaign.edited','campaign',c.id,{},trx);return campaignOr404(c.id,trx);
  });res.json(publicCampaign(result));
});
campaignRouter.post('/:id/preview',async(req,res)=>{
  const c=await campaignOr404(String(req.params.id)),draft=json(c.draft,{});
  const body=z.object({contact_id:z.string().uuid().optional()}).parse(req.body||{});
  const contact=body.contact_id?await db('contacts').where({id:body.contact_id}).first():{first_name:'Alex',last_name:'Sample',company_name:'Example Company',website:'https://example.com',city:'San Diego',custom_fields:{}};
  if(!contact)throw new HttpError(404,'Contact not found.');
  try {res.json({steps:draft.steps.map((s:any)=>renderStep(s,parseContact(contact))),sample:!body.contact_id});}catch(error){throw new HttpError(400,(error as Error).message);}
});
campaignRouter.post('/:id/test',permit('campaigns:write'),async(req,res)=>{
  const email=normalizeEmail(z.object({email:z.string().email().max(254)}).parse(req.body).email),c=await campaignOr404(String(req.params.id)),draft=json(c.draft,{});
  const account=await db('email_accounts').where({id:c.account_id}).first();
  if(account.status!=='active'||!account.verified_at)throw new HttpError(409,'Validate and activate the mailbox first.');
  let contact=await db('contacts').where({email}).first();
  if(!contact)throw new HttpError(400,'Create this controlled test address as a contact with test consent first.');
  const reason=await contactEligibility(contact,account,db,{reply:true});if(reason)throw new HttpError(400,reason);
  let content;try{content=renderStep(draft.steps[0],parseContact(contact));}catch(error){throw new HttpError(400,(error as Error).message);}
  const job={id:id(),kind:'send',account_id:c.account_id,campaign_id:c.id,payload:JSON.stringify({is_test:true,contact_id:contact.id,content:{...content,subject:('[TEST] '+content.subject).slice(0,998)},open_tracking:false,click_tracking:false}),status:'queued',due_at:new Date(),attempts:0,created_at:new Date(),updated_at:new Date()};
  await db.transaction(async trx=>{await trx('jobs').insert(job);await audit(req.user!.id,'campaign.test_queued','campaign',c.id,{contact_id:contact.id},trx);});
  res.status(202).json({job_id:job.id,message:'Test queued. Sending remains subject to pause, consent, sync, window and capacity checks.'});
});
campaignRouter.post('/:id/launch',permit('campaigns:write'),async(req,res)=>{
  const result=await db.transaction(async trx=>{
    await trx('business_settings').where({id:'agency'}).forUpdate().first();
    const c=await trx('campaigns').where({id:req.params.id}).forUpdate().first();if(!c)throw new HttpError(404,'Campaign not found.');if(c.status!=='draft')throw new HttpError(409,'Campaign has already been published.');
    const account=await trx('email_accounts').where({id:c.account_id}).first();if(account.status!=='active'||!account.verified_at)throw new HttpError(409,'Validate and activate the sending mailbox first.');
    const draft=draftSchema.parse(json(c.draft,{})),review=await audience(draft,account,trx);if(!review.included.length)throw new HttpError(400,'No eligible contacts. Review the audience exclusions.',review);
    const settings=await getSettings(trx);if(!settings.business_address?.trim())throw new HttpError(400,'Enter the business address in settings before launching marketing messages.');
    const version=await publish(c,draft,req.user!.id,trx),due=draft.scheduled_at?new Date(draft.scheduled_at):new Date();
    for(const contact of review.included){const enrollmentId=id();await trx('enrollments').insert({id:enrollmentId,campaign_id:c.id,version_id:version.id,contact_id:contact.id,account_id:c.account_id,status:'active',next_step:0,created_at:new Date(),updated_at:new Date()});await trx('jobs').insert({id:id(),kind:'send',account_id:c.account_id,campaign_id:c.id,enrollment_id:enrollmentId,step_position:0,payload:JSON.stringify({}),status:'queued',due_at:due,attempts:0,created_at:new Date(),updated_at:new Date()});}
    await trx('campaigns').where({id:c.id}).update({version_id:version.id,status:due>new Date()?'scheduled':'active',updated_at:new Date()});await audit(req.user!.id,'campaign.launched','campaign',c.id,{version:version.number,included:review.included.length,excluded:review.excluded.length},trx);
    return {campaign:publicCampaign(await campaignOr404(c.id,trx)),...review};
  });res.json(result);
});
for(const action of ['pause','resume','archive'] as const)campaignRouter.post(`/:id/${action}`,permit('campaigns:write'),async(req,res)=>{
  const result=await db.transaction(async trx=>{const c=await trx('campaigns').where({id:req.params.id}).forUpdate().first();if(!c)throw new HttpError(404,'Campaign not found.');
    if(action==='resume'&&c.status!=='paused')throw new HttpError(409,'Only paused campaigns can resume.');if(action==='pause'&&!['active','scheduled'].includes(c.status))throw new HttpError(409,'Only scheduled or active campaigns can pause.');
    const status=action==='pause'?'paused':action==='archive'?'archived':c.scheduled_at&&new Date(c.scheduled_at)>new Date()?'scheduled':'active';await trx('campaigns').where({id:c.id}).update({status,updated_at:new Date()});
    if(action==='archive'){await trx('enrollments').where({campaign_id:c.id}).whereIn('status',['active','paused']).update({status:'stopped',stop_reason:'Campaign archived',updated_at:new Date()});await trx('jobs').where({campaign_id:c.id}).whereIn('status',['queued','leased']).update({status:'cancelled',lease_owner:null,lease_until:null,updated_at:new Date()});}
    await audit(req.user!.id,`campaign.${action}`,'campaign',c.id,{},trx);return campaignOr404(c.id,trx);});res.json(publicCampaign(result));
});
campaignRouter.post('/:id/revise',permit('campaigns:write'),async(req,res)=>{
  const body=z.object({confirmed:z.literal(true),draft:draftSchema}).parse(req.body);
  const result=await db.transaction(async trx=>{await trx('business_settings').where({id:'agency'}).forUpdate().first();const c=await trx('campaigns').where({id:req.params.id}).forUpdate().first();if(!c)throw new HttpError(404,'Campaign not found.');if(!['active','paused','scheduled'].includes(c.status))throw new HttpError(409,'Only a running or paused campaign can be revised.');
    if(body.draft.account_id!==c.account_id)throw new HttpError(400,'Existing enrollments retain their original sending mailbox. Create a new campaign for a replacement mailbox.');
    const previous=json((await trx('campaign_versions').where({id:c.version_id}).first()).snapshot,{});if(JSON.stringify([...new Set(body.draft.contact_ids)].sort())!==JSON.stringify([...new Set(previous.contact_ids)].sort()))throw new HttpError(400,'Audience cannot change during revision. Create a new campaign for new contacts.');
    if((body.draft.scheduled_at?new Date(body.draft.scheduled_at).getTime():null)!==(previous.scheduled_at?new Date(previous.scheduled_at).getTime():null))throw new HttpError(400,'Published launch schedules cannot change during content revision. Pause the campaign or create a new campaign with a new launch time.');
    const inFlight=await trx('jobs').where({campaign_id:c.id,status:'leased'}).first();if(inFlight)throw new HttpError(409,'A message is currently processing. Pause and retry after its lease finishes.');
    const unknown=await trx('jobs').where({campaign_id:c.id,status:'held'}).first();if(unknown)throw new HttpError(409,'Reconcile held attempts before revising this campaign.');
    const active=await trx('enrollments').where({campaign_id:c.id}).whereIn('status',['active','paused']);for(const e of active){const contact=parseContact(await trx('contacts').where({id:e.contact_id}).first());try{for(const step of body.draft.steps.slice(e.next_step))renderStep(step,contact);}catch(error){throw new HttpError(400,(error as Error).message);}}
    const version=await publish(c,body.draft,req.user!.id,trx),settings=await getSettings(trx);
    for(const e of active){
      const step=version.snapshot.steps[e.next_step];await trx('enrollments').where({id:e.id}).update({version_id:version.id,...(!step?{status:'completed'}:{}),updated_at:new Date()});
      const pending=await trx('jobs').where({enrollment_id:e.id}).whereIn('status',['queued','failed','cancelled']);
      for(const job of pending){
        if(!step||Number(job.step_position)!==Number(e.next_step)){await trx('jobs').where({id:job.id}).update({status:'cancelled',last_error:'Step removed by explicit campaign revision',updated_at:new Date()});continue;}
        if(e.last_accepted_at)await trx('jobs').where({id:job.id}).update({due_at:followupTime(new Date(e.last_accepted_at),step.delay_days,settings),updated_at:new Date()});
        const attempt=await trx('send_attempts').where({job_id:job.id}).first();if(!attempt||['accepted','unknown','submitting'].includes(attempt.status))continue;
        const message=await trx('messages').where({attempt_id:attempt.id}).first();if(!message)continue;
        // Only definite, unsent content can be replaced. Accepted content and
        // every published version remain immutable history.
        await trx('tracking_events').where({message_id:message.id}).delete();await trx('tracked_links').where({message_id:message.id}).delete();await trx('tracking_tokens').where({message_id:message.id}).delete();
        const contact=parseContact(await trx('contacts').where({id:e.contact_id}).first()),rendered=renderStep(step,contact),marketing=await prepareMarketing({...message,...rendered},version.snapshot,settings,trx);
        await trx('messages').where({id:message.id}).update({...rendered,body_text:marketing.body_text,body_html:marketing.body_html,open_tracking:marketing.open_tracking,click_tracking:marketing.click_tracking});
      }
    }
    await trx('campaigns').where({id:c.id}).update({name:body.draft.name,draft:JSON.stringify(body.draft),version_id:version.id,open_tracking:body.draft.open_tracking,click_tracking:body.draft.click_tracking,updated_at:new Date()});
    await audit(req.user!.id,'campaign.revised','campaign',c.id,{from:c.version_id,to:version.id,scope:'Only unsent steps; accepted messages and original sending account preserved'},trx);return campaignOr404(c.id,trx);});res.json(publicCampaign(result));
});

export const templateRouter=Router();templateRouter.use(requireUser);
templateRouter.get('/',async(req,res)=>{const query=db('templates').orderBy('updated_at','desc');if(req.query.include_archived!=='true')query.where({archived:false});res.json({items:await query});});
templateRouter.post('/',permit('campaigns:write'),async(req,res)=>{const body=templateSchema.parse(req.body),row={...body,body_html:body.body_html?sanitizeEmail(body.body_html):null,id:id(),archived:false,created_by:req.user!.id,created_at:new Date(),updated_at:new Date()};await db.transaction(async trx=>{await trx('templates').insert(row);await audit(req.user!.id,'template.created','template',row.id,{},trx);});res.status(201).json(row);});
templateRouter.patch('/:id',permit('campaigns:write'),async(req,res)=>{const current=await db('templates').where({id:req.params.id}).first();if(!current)throw new HttpError(404,'Template not found.');const body=templateSchema.parse({...current,...req.body});await db.transaction(async trx=>{await trx('templates').where({id:current.id}).update({...body,body_html:body.body_html?sanitizeEmail(body.body_html):null,updated_at:new Date()});await audit(req.user!.id,'template.edited','template',current.id,{},trx);});res.json(await db('templates').where({id:current.id}).first());});
templateRouter.post('/:id/duplicate',permit('campaigns:write'),async(req,res)=>{const current=await db('templates').where({id:req.params.id}).first();if(!current)throw new HttpError(404,'Template not found.');const row={...current,id:id(),name:current.name+' (copy)',archived:false,created_by:req.user!.id,created_at:new Date(),updated_at:new Date()};await db.transaction(async trx=>{await trx('templates').insert(row);await audit(req.user!.id,'template.duplicated','template',row.id,{source:current.id},trx);});res.status(201).json(row);});
templateRouter.post('/:id/archive',permit('campaigns:write'),async(req,res)=>{if(!await db('templates').where({id:req.params.id}).first())throw new HttpError(404,'Template not found.');await db.transaction(async trx=>{await trx('templates').where({id:req.params.id}).update({archived:true,updated_at:new Date()});await audit(req.user!.id,'template.archived','template',String(req.params.id),{},trx);});res.json({ok:true});});
templateRouter.post('/:id/preview',async(req,res)=>{const template=await db('templates').where({id:req.params.id}).first();if(!template)throw new HttpError(404,'Template not found.');const body=z.object({contact_id:z.string().uuid()}).parse(req.body);const contact=await db('contacts').where({id:body.contact_id}).first();if(!contact)throw new HttpError(404,'Contact not found.');try{res.json(renderStep(template,parseContact(contact)));}catch(error){throw new HttpError(400,(error as Error).message);}});

export const inboxRouter=Router();inboxRouter.use(requireUser,async(_req,_res,next)=>{await ensureMailFeatures();await ensureInboxReads();next();});
inboxRouter.post('/process',permit('inbox:write'),async(req,res)=>{
  const command=z.object({mode:z.enum(['sync','inbox']).default('inbox')}).strict().parse(req.body||{});
  await consumeRateLimit('inbox-process:'+req.user!.id,20,60000);
  res.json(await runWorker({budgetMs:18000,maxJobs:10,syncOnly:command.mode==='sync',inboxOnly:true}));
});
async function withDeliveryStatus(messages:any[]) {
  const ids=messages.filter(m=>m.direction==='outbound'&&m.attempt_id).map(m=>m.attempt_id);
  const attempts=ids.length?await db('send_attempts as a').leftJoin('jobs as j','j.id','a.job_id').whereIn('a.id',ids).select('a.id','a.status','a.accepted_at','j.status as job_status'):[];
  const byId=new Map(attempts.map(a=>[a.id,a]));
  return messages.map(message=>{
    const attempt=byId.get(message.attempt_id);
    const send_status=!attempt?null:attempt.status==='accepted'?'accepted':['unknown','submitting'].includes(attempt.status)?(attempt.status==='unknown'?'held':'sending'):attempt.job_status==='leased'?'sending':attempt.job_status;
    return {...message,...(message.direction==='outbound'?{send_status,accepted_at:attempt?.accepted_at||null}:{})};
  });
}
const threadColumns=['id','attempt_id','account_id','contact_id','campaign_id','direction','from_email','to_email','subject','classification','assigned_to','received_at','created_at','message_id','in_reply_to','references_json','open_tracking'];
inboxRouter.get('/',async(req,res)=>{
  const filters=z.object({classification:z.enum(['human_reply','automatic','delivery_failure','unmatched','uncertain','outbound']).optional(),account_id:z.string().uuid().optional()}).parse(req.query);
  const query=db('messages');if(filters.account_id)query.where({account_id:filters.account_id});
  // Group headers before limiting conversations; older parents must not vanish
  // merely because a mailbox has received more than 200 individual messages.
  const groups=groupConversations(await query.select(threadColumns) as ThreadMessage[])
    .filter(group=>!filters.classification||group.messages.some(message=>message.classification===filters.classification)).slice(0,200);
  const latestIds=groups.map(group=>group.latest.id);
  const readIds=await readMessageIds(req.user!.id,groups.flatMap(group=>group.messages.filter(message=>message.direction==='inbound').map(message=>message.id)));
  const previews=latestIds.length?await db('messages').whereIn('id',latestIds).select('id',db.raw('LEFT(body_text, 200) as preview')):[];
  const previewById=new Map(previews.map(message=>[message.id,message.preview]));
  const items=groups.map(({root,latest,messages})=>{
    const {references_json,in_reply_to,message_id,...summary}=latest;
    return {...summary,id:root.id,thread_id:root.id,subject:root.subject,latest_subject:latest.subject,
      latest_message_id:latest.id,message_ids:messages.map(message=>message.id),message_count:messages.length,unread_count:messages.filter(message=>message.direction==='inbound'&&!readIds.has(message.id)).length,preview:previewById.get(latest.id)||''};
  });
  res.json({items:await enrichMail(await withDeliveryStatus(items))});
});
inboxRouter.get('/outbox',async(req,res)=>{
  const filters=z.object({account_id:z.string().uuid().optional()}).parse(req.query);
  const query=db('jobs').where({kind:'send'}).whereIn('status',['queued','leased','held','failed']).whereRaw("JSON_TYPE(JSON_EXTRACT(payload, '$.is_manual')) = 'BOOLEAN' AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.is_manual')) = 'true'").orderBy('created_at','desc').limit(50);
  if(filters.account_id)query.where('account_id',filters.account_id);
  const rows=await query.select('id','account_id','status','last_error','created_at','updated_at','payload');
  res.json({items:rows.map(({payload,...row})=>{const data=json<any>(payload,{});return {...row,recipient:data.manual_recipient,subject:data.content?.subject||'',status:row.status==='leased'?'sending':row.status};})});
});
inboxRouter.post('/compose',permit('inbox:write'),async(req,res)=>{
  const body=manualContentSchema.extend({account_id:z.string().uuid(),to:z.string().trim().email().max(254).transform(normalizeEmail),subject:stepSchema.shape.subject.transform(s=>s.trim()).refine(s=>s.length>0,'Enter a subject')}).strict().parse(req.body),jobId=id();
  const attachments=encryptAttachments(body.attachments);
  await db.transaction(async trx=>{
    await trx('business_settings').where({id:'agency'}).forUpdate().first();
    const account=await trx('email_accounts').where({id:body.account_id}).first();if(!account)throw new HttpError(400,'Mailbox not found.');
    const reason=await manualRecipientEligibility(body.to,account,trx);if(reason)throw new HttpError(400,reason);
    const contact=await trx('contacts').where({email:body.to}).first();
    await trx('jobs').insert({id:jobId,kind:'send',account_id:account.id,payload:JSON.stringify({is_manual:true,manual_recipient:body.to,contact_id:contact?.id||null,attachments,open_tracking:body.open_tracking===true,content:{subject:body.subject,...manualContent(body,await getSettings(trx))}}),status:'queued',due_at:new Date(),attempts:0,created_at:new Date(),updated_at:new Date()});
    if(body.draft_id)await trx('mail_drafts').where({id:body.draft_id,user_id:req.user!.id}).delete();
    await audit(req.user!.id,'inbox.compose_queued','email_account',account.id,{job_id:jobId},trx);
  });res.status(202).json({job_id:jobId});
});
inboxRouter.get('/:id',async(req,res)=>{
  const message=await db('messages').where({id:req.params.id}).first();if(!message)throw new HttpError(404,'Message not found.');
  const participant=conversationParticipant(message);
  const headers=await db('messages').where({account_id:message.account_id}).select(threadColumns);
  const conversation=groupConversations(headers as ThreadMessage[]).find(group=>group.messages.some(item=>item.id===message.id))!;
  const thread=await enrichMail(await withDeliveryStatus(await db('messages').whereIn('id',conversation.messages.map(item=>item.id))));
  const readIds=await readMessageIds(req.user!.id,thread.map(message=>message.id));
  const order=new Map(conversation.messages.map((item,index)=>[item.id,index]));thread.sort((a,b)=>order.get(a.id)!-order.get(b.id)!);
  const [delivery]=await withDeliveryStatus([message]);
  res.json({...delivery,thread_id:conversation.root.id,conversation_subject:conversation.root.subject,message_count:thread.length,reply_message_id:conversation.latest.id,
    body_html:message.body_html?sanitizeEmail(message.body_html):null,references_json:json(message.references_json,[]),thread:thread.map(m=>({...m,is_read:m.direction!=='inbound'||readIds.has(m.id),body_html:m.body_html?sanitizeEmail(m.body_html):null})),contact:await db('contacts').where({email:participant}).first()||null});
});
inboxRouter.post('/:id/read',async(req,res)=>{
  const body=z.object({message_ids:z.array(z.string().uuid()).min(1).max(1000)}).strict().parse(req.body);
  const message=await db('messages').where({id:req.params.id}).first();if(!message)throw new HttpError(404,'Message not found.');
  const headers=await db('messages').where({account_id:message.account_id}).select(threadColumns);
  const conversation=groupConversations(headers as ThreadMessage[]).find(group=>group.messages.some(item=>item.id===message.id))!;
  const allowed=new Set(conversation.messages.map(item=>item.id));
  if(body.message_ids.some(messageId=>!allowed.has(messageId)))throw new HttpError(400,'Read receipts must belong to this conversation.');
  // Acknowledge only the displayed snapshot; a later arriving reply stays unread.
  const requested=new Set(body.message_ids),ids=conversation.messages.filter(item=>item.direction==='inbound'&&requested.has(item.id)).map(item=>item.id);
  if(ids.length)await db('inbox_reads').insert(ids.map(messageId=>({user_id:req.user!.id,message_id:messageId,read_at:new Date()}))).onConflict(['user_id','message_id']).ignore();
  res.json({read_ids:ids});
});
inboxRouter.patch('/:id',permit('inbox:write'),async(req,res)=>{
  const body=z.object({contact_id:z.string().uuid().nullable().optional(),assigned_to:z.string().uuid().nullable().optional()}).parse(req.body);
  await db.transaction(async trx=>{
    await trx('business_settings').where({id:'agency'}).forUpdate().first();
    const message=await trx('messages').where({id:req.params.id}).forUpdate().first();if(!message)throw new HttpError(404,'Message not found.');
    if(body.contact_id){
      const contact=await trx('contacts').where({id:body.contact_id}).forUpdate().first();if(!contact)throw new HttpError(400,'Contact not found.');
      if(message.direction==='inbound'&&normalizeEmail(contact.email)!==normalizeEmail(message.from_email))throw new HttpError(400,'Choose a contact whose email matches this message sender.');
    }
    if(body.assigned_to&&!await trx('users').where({id:body.assigned_to,disabled:false}).first())throw new HttpError(400,'Team member not found.');
    await trx('messages').where({id:message.id}).update(body);
    if(body.contact_id&&message.direction==='inbound'){
      const classification=message.classification==='unmatched'?'uncertain':message.classification;
      await trx('messages').where({id:message.id}).update({classification,reviewed_at:null,review_action:null});
      await stopContact(body.contact_id,`Manually matched ${classification}`,classification==='human_reply'?'stopped':'paused',trx);
    }
    await audit(req.user!.id,'inbox.updated','message',message.id,body,trx);
  });res.json({ok:true});
});
inboxRouter.post('/:id/reply',permit('inbox:write'),async(req,res)=>{
  const body=manualContentSchema.strict().parse(req.body),jobId=id();
  const attachments=encryptAttachments(body.attachments);
  await db.transaction(async trx=>{
    await trx('business_settings').where({id:'agency'}).forUpdate().first();
    const message=await trx('messages').where({id:req.params.id}).forUpdate().first();if(!message)throw new HttpError(404,'Message not found.');
    const account=await trx('email_accounts').where({id:message.account_id}).first();
    const recipient=normalizeEmail(message.direction==='inbound'?message.from_email:message.to_email);
    const reason=await manualRecipientEligibility(recipient,account,trx);if(reason)throw new HttpError(400,reason);
    const contact=await trx('contacts').where({email:recipient}).first();
    await trx('jobs').insert({id:jobId,kind:'send',account_id:message.account_id,campaign_id:message.campaign_id,payload:JSON.stringify({is_manual:true,manual_recipient:recipient,is_reply:true,contact_id:contact?.id||null,reply_source_id:message.id,reply_recipient:recipient,in_reply_to:message.message_id,references:[...json<string[]>(message.references_json,[]),message.message_id].slice(-30),attachments,open_tracking:body.open_tracking===true,content:{subject:(/^re:/i.test(message.subject)?message.subject:'Re: '+message.subject).replace(/[\r\n]/g,' ').slice(0,998),...manualContent(body,await getSettings(trx))}}),status:'queued',due_at:new Date(),attempts:0,created_at:new Date(),updated_at:new Date()});
    if(body.draft_id)await trx('mail_drafts').where({id:body.draft_id,user_id:req.user!.id}).delete();
    await audit(req.user!.id,'inbox.reply_queued','message',message.id,{job_id:jobId},trx);
  });res.status(202).json({job_id:jobId});
});
inboxRouter.post('/:id/review',permit('inbox:write'),async(req,res)=>{
  const body=z.object({action:z.enum(['stop','resume'])}).parse(req.body);
  const result=await db.transaction(async trx=>{
    await trx('business_settings').where({id:'agency'}).forUpdate().first();
    const message=await trx('messages').where({id:req.params.id}).forUpdate().first();if(!message)throw new HttpError(404,'Message not found.');
    if(!message.contact_id||message.direction!=='inbound'||!['automatic','uncertain','delivery_failure'].includes(message.classification))throw new HttpError(400,'Only matched automatic, uncertain, or delivery-report messages can be reviewed. Human replies keep outreach stopped.');
    await trx('messages').where({id:message.id}).update({reviewed_at:new Date(),review_action:body.action});
    let resumed=false,remainingReason:string|null=null;
    if(body.action==='stop')await stopContact(message.contact_id,'Manual inbox review: stop outreach','stopped',trx);
    else{
      const contact=await trx('contacts').where({id:message.contact_id}).first(),account=await trx('email_accounts').where({id:message.account_id}).first();remainingReason=await contactEligibility(contact,account,trx);
      // Save this individual decision even when another message still holds the
      // contact; release outreach only after every review hold is resolved.
      if(!remainingReason){
        const settings=await getSettings(trx),enrollments=await trx('enrollments').where({contact_id:message.contact_id,status:'paused'}).where(builder=>builder.where('stop_reason','like','%reply requires review%').orWhere('stop_reason','like','Delivery report requires review').orWhere('stop_reason','like','Manually matched%'));
        for(const enrollment of enrollments){await trx('enrollments').where({id:enrollment.id}).update({status:'active',stop_reason:null,updated_at:new Date()});await trx('jobs').where({enrollment_id:enrollment.id,step_position:enrollment.next_step,status:'cancelled'}).update({status:'queued',due_at:nextSendingTime(new Date(),settings),last_error:null,updated_at:new Date()});}resumed=enrollments.length>0;
      }
    }
    await audit(req.user!.id,'inbox.reviewed','message',message.id,body,trx);
    return {ok:true,resumed,reason:remainingReason};
  });res.json(result);
});
