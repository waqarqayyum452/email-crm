import { ensureProspectDeletion } from './prospect-deletion.js';
import { Router } from './http.js';
import { z } from 'zod';
import { db, json } from './db.js';
import { config } from './config.js';
import { requireUser, permit, ownerOnly } from './auth.js';
import { getSettings } from './settings.js';
import { audit, HttpError, csvRows } from './lib/util.js';
import { retryFailedJobs, reconcileAttempt, requestSync } from './worker.js';

const dateFilter=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{const d=new Date(v+'T00:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===v;},'Use a valid calendar date.');
const filterSchema=z.object({from:dateFilter.optional(),to:dateFilter.optional(),campaign_id:z.string().uuid().optional(),account_id:z.string().uuid().optional()}).refine(f=>!f.from||!f.to||f.from<=f.to,'Start date must be before the end date.');
type Filters=z.infer<typeof filterSchema>;
const count=async(q:any,column='*')=>Number((await q.count({n:column}).first())?.n||0);
function window(q:any,column:string,f:Filters) {if(f.from)q.where(column,'>=',new Date(f.from+'T00:00:00Z'));if(f.to){const end=new Date(f.to+'T00:00:00Z');end.setUTCDate(end.getUTCDate()+1);q.where(column,'<',end);}return q;}
function filters(q:any,table:string,f:Filters) {if(f.campaign_id)q.where(table+'.campaign_id',f.campaign_id);if(f.account_id)q.where(table+'.account_id',f.account_id);return q;}
export async function metricsFor(f:Filters={}) {
  await ensureProspectDeletion();const settings=await getSettings();
  const acceptedQ=()=>window(filters(db('send_attempts').where({'send_attempts.status':'accepted','send_attempts.is_test':false}),'send_attempts',f),'send_attempts.accepted_at',f);
  const messagesQ=(classification:string)=>window(filters(db('messages').where({classification,is_test:false,direction:'inbound'}),'messages',f),'received_at',f);
  const eventQ=(kind:string)=>{const q=db('tracking_events as e').join('messages as m','m.id','e.message_id').where({'e.kind':kind,'m.is_test':false});if(settings.filter_bots&&['open','click'].includes(kind))q.where('e.bot',false);if(f.campaign_id)q.where('e.campaign_id',f.campaign_id);if(f.account_id)q.where('m.account_id',f.account_id);return window(q,'e.created_at',f);};
  const unique=async(kind:string)=>Number((await eventQ(kind).countDistinct({n:'e.message_id'}).first())?.n||0);
  const [accepted,unique_opens,unique_clicks,human_replies,automatic_replies,bounces,unsubscribes,failed_attempts,qualified,won,active_campaigns,series]=await Promise.all([
    count(acceptedQ()),unique('open'),unique('click'),count(messagesQ('human_reply')),count(messagesQ('automatic')),count(eventQ('bounce')),unique('unsubscribe'),
    count(window(filters(db('send_attempt_events as ae').join('send_attempts as sa','sa.id','ae.attempt_id').whereIn('ae.status',['temporary','permanent','auth','limit']).where('sa.is_test',false),'sa',f),'ae.created_at',f)),
    count(db('contacts as c').whereNull('c.deleted_at').join('pipeline_stages as s','s.id','c.stage_id').where('s.kind','qualified'),'c.id'),
    count(db('contacts as c').join('pipeline_stages as s','s.id','c.stage_id').where('s.kind','won'),'c.id'),
    count(db('campaigns').whereIn('status',['active','scheduled']).modify(q=>{if(f.account_id)q.where('account_id',f.account_id);if(f.campaign_id)q.where('id',f.campaign_id);})),
    acceptedQ().select(db.raw('DATE(accepted_at) as date')).count({accepted:'*'}).groupByRaw('DATE(accepted_at)').orderBy('date'),
  ]);
  const uniqueRecipients=Number((await acceptedQ().countDistinct({n:'recipient'}).first())?.n||0);
  const humanReplyContacts=Number((await messagesQ('human_reply').countDistinct({n:'contact_id'}).first())?.n||0);
  const trackedCount=async(field:string)=>Number((await acceptedQ().join('messages as tm','tm.attempt_id','send_attempts.id').where('tm.'+field,true).countDistinct({n:'send_attempts.id'}).first())?.n||0);
  const [openEnabled,clickEnabled]=await Promise.all([trackedCount('open_tracking'),trackedCount('click_tracking')]);
  return {metrics:{accepted,unique_opens,unique_clicks,human_replies,automatic_replies,bounces,unsubscribes,failed_attempts,qualified,won,active_campaigns},series:series.map((r:any)=>({date:r.date instanceof Date?r.date.toISOString().slice(0,10):String(r.date),accepted:Number(r.accepted)})),denominators:{smtp_accepted_messages:accepted,open_tracking_messages:openEnabled,click_tracking_messages:clickEnabled,unique_recipients:uniqueRecipients,human_reply_contacts:humanReplyContacts,open_rate:openEnabled?unique_opens/openEnabled:null,click_rate:clickEnabled?unique_clicks/clickEnabled:null,reply_rate:uniqueRecipients?humanReplyContacts/uniqueRecipients:null},definitions:{accepted:'SMTP accepted, not proof of delivery or inbox placement. Tests excluded.',engagement:'Approximate unique messages with events in the date range; may include messages sent before the range. Proxy preload and scanner visits can be included.',conversions:'Qualified leads and won opportunities are current agency-wide stage totals, independent of campaign/date filters.',rates:'Event dates and accepted-message dates can differ. Compare cohorts before interpreting rates.'}};
}
export async function healthSnapshot() {
  const [accounts,jobCounts,state,unknown,failed]=await Promise.all([db('email_accounts').select('id','label','email','status','verified_at','last_sync_at','last_successful_sync_at','last_error','is_default'),db('jobs').select('status').count({count:'*'}).groupBy('status'),db('worker_state').where({id:'scheduler'}).first(),db('send_attempts').where({status:'unknown'}).orderBy('created_at','desc').limit(100),db('jobs').whereIn('status',['failed','held']).orderBy('updated_at','desc').limit(100)]);
  const jobs=Object.fromEntries(jobCounts.map((j:any)=>[j.status,Number(j.count)]));const settings=await getSettings();
  const lastSync=accounts.map(a=>a.last_sync_at).filter(Boolean).sort((a,b)=>new Date(b).getTime()-new Date(a).getTime())[0]||null;
  return {database:'connected',live_send_enabled:config.liveSendEnabled,paused:settings.paused,last_heartbeat:state?.last_heartbeat||null,last_sync:lastSync,pending_jobs:(jobs.queued||0)+(jobs.leased||0),failed_jobs:jobs.failed||0,held_jobs:jobs.held||0,jobs,accounts,unknown_attempts:unknown,failed_job_items:failed.map(({payload,...j})=>j),scheduler_stale:!state?.last_heartbeat||Date.now()-new Date(state.last_heartbeat).getTime()>Math.max(180,settings.poll_interval_seconds*3)*1000,sync_stale:accounts.some(a=>a.status==='active'&&(!a.last_sync_at||Date.now()-new Date(a.last_sync_at).getTime()>settings.sync_stale_seconds*1000)),last_error:state?.last_error||null};
}
export const reportingRouter=Router();reportingRouter.use(requireUser);
reportingRouter.get('/overview',async(_req,res)=>{
  const [analytics,health,settings,activity]=await Promise.all([metricsFor(),healthSnapshot(),getSettings(),db('audit_logs').select('id','action','entity_type','entity_id','created_at').orderBy('created_at','desc').limit(15)]);
  const used=await count(db('send_attempts').whereIn('status',['reserved','submitting','accepted','unknown']).whereRaw('COALESCE(accepted_at, submitted_at, reserved_at) >= ?',[new Date(Date.now()-86400000)]));
  const mailboxUsage=await db('send_attempts').select('account_id').whereIn('status',['reserved','submitting','accepted','unknown']).whereRaw('COALESCE(accepted_at, submitted_at, reserved_at) >= ?',[new Date(Date.now()-86400000)]).count({used:'*'}).groupBy('account_id');
  res.json({...analytics,health,capacity:{used,cap:settings.application_cap,provider_cap:settings.provider_cap,mailboxes:mailboxUsage.map((a:any)=>({account_id:a.account_id,used:Number(a.used)})),outside_crm_warning:'Messages sent outside the CRM also use provider capacity and may not be counted here.'},activity});
});
reportingRouter.get('/analytics',async(req,res)=>res.json(await metricsFor(filterSchema.parse(req.query))));
reportingRouter.get('/analytics/export.csv',async(req,res)=>{const result=await metricsFor(filterSchema.parse(req.query));res.type('text/csv').set('Content-Disposition','attachment; filename="analytics.csv"').send(csvRows([['metric','value'],...Object.entries(result.metrics),...Object.entries(result.denominators)]));});
reportingRouter.get('/health',async(_req,res)=>res.json(await healthSnapshot()));
reportingRouter.post('/health/retry',permit('system:write'),async(req,res)=>{const result=await retryFailedJobs(req.user!.id);res.json({ok:true,result});});
reportingRouter.post('/health/reconcile',ownerOnly,async(req,res)=>{const body=z.object({attempt_id:z.string().uuid(),resolution:z.enum(['accepted','not_sent']),accepted_at:z.string().datetime({offset:true}).optional()}).parse(req.body);await reconcileAttempt(body.attempt_id,body.resolution,req.user!.id,body.accepted_at?new Date(body.accepted_at):undefined);res.json({ok:true});});
reportingRouter.post('/accounts/:id/sync',permit('system:write'),async(req,res)=>{if(!await db('email_accounts').where({id:req.params.id}).first())throw new HttpError(404,'Mailbox not found.');await requestSync(String(req.params.id));await audit(req.user!.id,'inbox_sync_requested','email_account',String(req.params.id));res.json({ok:true,message:'Sync queued. The scheduler will process it.'});});
