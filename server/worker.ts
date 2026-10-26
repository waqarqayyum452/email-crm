import {ensureCampaignDesigns} from './campaign-designs.js';
import { randomUUID } from 'node:crypto';
import { db, json, type Database } from './db.js';
import { config } from './config.js';
import { getSettings } from './settings.js';
import { audit, HttpError, id, normalizeEmail } from './lib/util.js';
import { renderStep, nextSendingTime, followupTime, smtpFailure } from './engine/content.js';
import { consumedStatuses, contactEligibility, manualRecipientEligibility, stopContact } from './engine/policy.js';
import { smtpTransport, syncMailbox } from './engine/mail.js';
import { prepareMarketing, prepareManualTracking } from './tracking.js';
import { ensureMailFeatures, saveMessageDetails, smtpAttachments } from './engine/mail-features.js';

const now = () => new Date();
const leaseMs = 60000;
const delayJob = async (trx:Database, job:any, reason:string, due=new Date(Date.now()+60000)) => {await trx('jobs').where({id:job.id}).update({status:'queued',due_at:due,lease_owner:null,lease_until:null,last_error:reason,updated_at:now()});return null;};
const cancelJob = async(trx:Database,job:any,reason:string) => {await trx('jobs').where({id:job.id}).update({status:'cancelled',lease_owner:null,lease_until:null,last_error:reason,updated_at:now()});return null;};

async function recordOutcome(trx:Database,attemptId:string,status:string,errorCode:string|null=null,errorMessage:string|null=null) {
  const attempt=await trx('send_attempts').where({id:attemptId}).first();if(!attempt)return;
  await trx('send_attempt_events').insert({id:id(),attempt_id:attempt.id,ordinal:attempt.submission_count||0,status,error_code:errorCode,error_message:errorMessage,created_at:now()}).onConflict(['attempt_id','ordinal','status']).ignore();
}

function bounded<T>(promise:Promise<T>,deadline:number,abort?:()=>void,onLate?:(value:T)=>void):Promise<T> {
  return new Promise((resolve,reject)=>{
    let settled=false;
    const timer=setTimeout(()=>{settled=true;abort?.();reject(Object.assign(new Error('Worker network budget expired'),{code:'ETIMEDOUT'}));},Math.max(1,deadline-Date.now()));
    promise.then(value=>{if(settled){onLate?.(value);return;}settled=true;clearTimeout(timer);resolve(value);},error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error);});
  });
}

/** MySQL 8 / MariaDB 10.11 SKIP LOCKED prevents two workers from claiming one job. */
export async function claimJob(workerId:string,syncOnly=false,inboxOnly=false) {
  // InnoDB can still deadlock while updating a selected queue index row. This
  // transaction has no network/submission side effects, so retry only the claim.
  for(let retry=0;;retry++)try{return await db.transaction(async trx=>{
    const query=trx('jobs').where({status:'queued'}).where('due_at','<=',now());
    if(syncOnly)query.where({kind:'sync'});
    else if(inboxOnly)query.where(function(){this.where({kind:'sync'}).orWhere(function(){this.where({kind:'send'}).whereRaw("JSON_TYPE(JSON_EXTRACT(payload, '$.is_manual')) = 'BOOLEAN' AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.is_manual')) = 'true'");});});
    const job=await query.orderByRaw("CASE WHEN kind = 'sync' THEN 0 ELSE 1 END").orderBy('due_at').forUpdate().skipLocked().first();if(!job)return null;
    await trx('jobs').where({id:job.id}).update({status:'leased',lease_owner:workerId,lease_until:new Date(Date.now()+leaseMs),updated_at:now()});
    return {...job,status:'leased',lease_owner:workerId,lease_until:new Date(Date.now()+leaseMs)};
  });}catch(error){if((error as {code?:string}).code!=='ER_LOCK_DEADLOCK'||retry>=2)throw error;}
}

/** Reserved work can restart; any submission that may have reached SMTP is held. */
export async function recoverExpiredLeases() {
  return db.transaction(async trx=>{
    await trx('business_settings').where({id:'agency'}).forUpdate().first();
    const expired=await trx('jobs').where({status:'leased'}).where('lease_until','<',now()).forUpdate().skipLocked();
    for(const job of expired){
      const attempt=await trx('send_attempts').where({job_id:job.id}).first();
      if(attempt&&['submitting','unknown'].includes(attempt.status)){
        await trx('send_attempts').where({id:attempt.id}).update({status:'unknown',retryable:false,error_message:'Worker lease expired after submission began. Manual reconciliation is required.'});
        await recordOutcome(trx,attempt.id,'unknown','LEASE_EXPIRED','Worker lease expired after submission began.');
        await trx('jobs').where({id:job.id}).update({status:'held',lease_owner:null,lease_until:null,last_error:'Unknown SMTP acceptance after restart',updated_at:now()});
      }else if(attempt?.status==='accepted'){
        // Accepted and next-job creation normally commit atomically. Re-enter the
        // idempotent completion path if an older worker had persisted acceptance.
        await finishAccepted(attempt.id,new Date(attempt.accepted_at||attempt.submitted_at),trx);
      }else{
        if(attempt?.status==='reserved'){await trx('send_attempts').where({id:attempt.id}).update({status:'cancelled',retryable:true,error_message:'Reservation recovered before submission'});await recordOutcome(trx,attempt.id,'cancelled','LEASE_EXPIRED','Reservation recovered before submission');}
        await trx('jobs').where({id:job.id}).update({status:'queued',due_at:now(),lease_owner:null,lease_until:null,last_error:'Recovered expired lease before submission',updated_at:now()});
      }
    }return expired.length;
  });
}

export async function requestSync(accountId:string) {
  return db.transaction(async trx=>{
    const account=await trx('email_accounts').where({id:accountId}).forUpdate().first();if(!account||account.deleted_at)throw new HttpError(404,'Mailbox not found.');
    const existing=await trx('jobs').where({kind:'sync',account_id:accountId}).whereIn('status',['queued','leased']).first();if(existing)return existing.id;
    const jobId=id();await trx('jobs').insert({id:jobId,kind:'sync',account_id:accountId,payload:JSON.stringify({}),status:'queued',due_at:now(),attempts:0,created_at:now(),updated_at:now()});return jobId;
  });
}

async function queueDueSync(settings:any) {
  const accounts=await db('email_accounts').whereNotNull('imap_secret').whereNotNull('verified_at').whereIn('status',['active','paused','error']);
  // Queue at most once per UTC polling period. Exact elapsed-time comparisons
  // skip a minute when the next cron arrives slightly earlier than the last.
  const periodMs=settings.poll_interval_seconds*1000,currentPeriod=Math.floor(Date.now()/periodMs);
  for(const account of accounts){const previous=await db('jobs').where({account_id:account.id,kind:'sync'}).orderBy('created_at','desc').first();if(!previous||Math.floor(new Date(previous.created_at).getTime()/periodMs)<currentPeriod)await requestSync(account.id);}
}

async function replyRecipientIssue(trx:Database,job:any,payload:any,contact:any):Promise<string|null> {
  const manual=payload.is_manual===true;
  if(!payload.is_reply&&!manual)return null;
  const manualChanged='Manual recipient changed. Open the message and queue it again.';
  if(manual&&(job.enrollment_id||typeof payload.manual_recipient!=='string'||!payload.manual_recipient||payload.manual_recipient!==normalizeEmail(payload.manual_recipient)))return 'Manual recipient could not be verified. Compose the message again.';
  // Legacy replies have no immutable recipient/source snapshot. Require a new
  // operator-reviewed reply rather than guessing from a mutable contact match.
  const changed='Reply recipient changed. Open the original message, verify the reply address, and queue a new reply.';
  let recipient=payload.manual_recipient;
  if(payload.is_reply){
    if(typeof payload.reply_source_id!=='string'||!payload.reply_source_id||typeof payload.reply_recipient!=='string'||!payload.reply_recipient)return 'Reply recipient could not be verified. Open the original message and queue a new reply.';
    const source=await trx('messages').where({id:payload.reply_source_id}).first();
    if(!source||!['inbound','outbound'].includes(source.direction)||source.account_id!==job.account_id||payload.in_reply_to!==source.message_id)return changed;
    recipient=normalizeEmail(source.direction==='inbound'?source.from_email:source.to_email);
    if(payload.reply_recipient!==recipient||(manual?payload.manual_recipient!==recipient:source.contact_id!==payload.contact_id||!contact||contact.id!==payload.contact_id||normalizeEmail(contact.email)!==recipient))return changed;
  }
  const attempt=await trx('send_attempts').where({job_id:job.id}).first();
  if(attempt){
    if(attempt.account_id!==job.account_id||(!manual&&attempt.contact_id!==contact.id)||normalizeEmail(attempt.recipient)!==recipient)return payload.is_reply?changed:manualChanged;
    const message=await trx('messages').where({attempt_id:attempt.id}).first();
    if(message&&(message.account_id!==job.account_id||(!manual&&message.contact_id!==contact.id)||normalizeEmail(message.to_email)!==recipient||(message.in_reply_to||null)!==(payload.in_reply_to||null)))return payload.is_reply?changed:manualChanged;
  }
  return null;
}

async function actualEligibility(trx:Database,job:any,account:any,settings:any,payload:any) {
  if(settings.paused)return 'All sending is paused in settings';
  if(!config.liveSendEnabled)return 'Sending is disabled by LIVE_SEND_ENABLED';
  if(!payload.is_reply&&payload.is_manual!==true&&!String(settings.business_address||'').trim())return 'Enter the business address before sending marketing or test messages';
  if(!account||account.status!=='active'||!account.verified_at)return 'Mailbox must be active and connection-validated';
  if(!account.last_sync_at||Date.now()-new Date(account.last_sync_at).getTime()>settings.sync_stale_seconds*1000)return 'Inbox sync is stale; sending is paused until a successful sync';
  const enrollment=job.enrollment_id?await trx('enrollments').where({id:job.enrollment_id}).first():null;
  if(job.enrollment_id&&(!enrollment||enrollment.status!=='active'))return 'Enrollment is stopped or paused';
  if(!payload.is_test&&!payload.is_reply&&payload.is_manual!==true){const campaign=await trx('campaigns').where({id:job.campaign_id}).first();if(!campaign||!['active','scheduled'].includes(campaign.status))return 'Campaign is not active';if(campaign.scheduled_at&&new Date(campaign.scheduled_at)>now())return 'Campaign schedule is not due';}
  const contact=payload.is_manual===true?await trx('contacts').where({email:typeof payload.manual_recipient==='string'?payload.manual_recipient:''}).first():await trx('contacts').where({id:enrollment?.contact_id||payload.contact_id}).first();
  const recipientIssue=await replyRecipientIssue(trx,job,payload,contact);if(recipientIssue)return recipientIssue;
  if(payload.is_manual===true)return manualRecipientEligibility(payload.manual_recipient,account,trx);
  const reason=await contactEligibility(contact,account,trx,{reply:!!payload.is_reply||!!payload.is_test});if(reason)return reason;
  return null;
}

/** The agency settings lock serializes capacity across all mailboxes and workers. */
export async function reserveSend(claimed:any) {
  await ensureCampaignDesigns();
  await ensureMailFeatures();
  return db.transaction(async trx=>{
    await trx('business_settings').where({id:'agency'}).forUpdate().first();
    const job=await trx('jobs').where({id:claimed.id}).forUpdate().first();if(!job||job.status!=='leased'||job.lease_owner!==claimed.lease_owner)return null;
    const settings=await getSettings(trx),account=await trx('email_accounts').where({id:job.account_id}).first(),payload=json(job.payload,{});
    const reason=await actualEligibility(trx,job,account,settings,payload);
    if(reason){if(/suppressed|consent|evidence|outreach|no longer exists|Enrollment|^(?:Reply|Manual) recipient|valid recipient/i.test(reason))return cancelJob(trx,job,reason);return delayJob(trx,job,reason,new Date(Date.now()+60000));}
    // Individually written Inbox mail is ready for the next worker tick. The
    // campaign window and pacing apply only to automated/test campaign work.
    if(payload.is_manual!==true){const eligibleAt=nextSendingTime(now(),settings);if(eligibleAt.getTime()>Date.now()+1000)return delayJob(trx,job,'Outside the configured sending window',eligibleAt);}
    const since=new Date(Date.now()-86400000);
    const capacity=()=>trx('send_attempts').whereIn('status',consumedStatuses).whereRaw('COALESCE(accepted_at, submitted_at, reserved_at) > ?',[since]);
    const total=Number((await capacity().count({count:'id'}).first())?.count||0),provider=Number((await capacity().where({account_id:account.id}).count({count:'id'}).first())?.count||0);
    if(total>=settings.application_cap||provider>=settings.provider_cap){const earliest=await capacity().min({oldest:trx.raw('COALESCE(accepted_at, submitted_at, reserved_at)')}).first();return delayJob(trx,job,'Rolling 24-hour sending capacity reached',new Date(Math.max(Date.now()+60000,new Date(earliest?.oldest as any).getTime()+86401000)));}
    const recent=await trx('send_attempts').where({account_id:account.id}).whereIn('status',consumedStatuses).orderByRaw('COALESCE(accepted_at, submitted_at, reserved_at) DESC').first();
    const spaced=recent?new Date(new Date(recent.accepted_at||recent.submitted_at||recent.reserved_at).getTime()+settings.min_interval_seconds*1000):now();if(payload.is_manual!==true&&spaced>now())return delayJob(trx,job,'Minimum interval between messages',spaced);
    const enrollment=job.enrollment_id?await trx('enrollments').where({id:job.enrollment_id}).first():null,contact=payload.is_manual===true?await trx('contacts').where({email:payload.manual_recipient}).first():await trx('contacts').where({id:enrollment?.contact_id||payload.contact_id}).first();
    const recipient=payload.is_manual===true?payload.manual_recipient:payload.is_reply?payload.reply_recipient:contact.email;
    let content=payload.content,version:any=null;
    if(enrollment){const step=await trx('sequence_steps').where({version_id:enrollment.version_id,position:job.step_position}).first();if(!step){await trx('enrollments').where({id:enrollment.id}).update({status:'completed',updated_at:now()});await trx('jobs').where({id:job.id}).update({status:'completed',lease_owner:null,lease_until:null,updated_at:now()});return null;}version=json((await trx('campaign_versions').where({id:enrollment.version_id}).first()).snapshot,{});try{content=renderStep(step,{...contact,custom_fields:json(contact.custom_fields,{})},version);}catch(error){await trx('enrollments').where({id:enrollment.id}).update({status:'paused',stop_reason:(error as Error).message,updated_at:now()});return cancelJob(trx,job,(error as Error).message);}}
    let attempt=await trx('send_attempts').where({job_id:job.id}).first();
    if(attempt&&['unknown','submitting'].includes(attempt.status)){await trx('jobs').where({id:job.id}).update({status:'held',lease_owner:null,lease_until:null,updated_at:now()});return null;}
    if(attempt?.status==='accepted'){await finishAccepted(attempt.id,new Date(attempt.accepted_at),trx);return null;}
    const messageId=attempt?.message_id||`<${job.id}@${account.email.split('@')[1]}>`;
    if(!attempt){attempt={id:id(),job_id:job.id,account_id:account.id,campaign_id:job.campaign_id||null,enrollment_id:job.enrollment_id||null,contact_id:contact?.id||null,message_id:messageId,recipient,status:'reserved',retryable:false,is_test:!!payload.is_test,is_reply:!!payload.is_reply,submission_count:1,reserved_at:now(),created_at:now()};await trx('send_attempts').insert(attempt);}else{await trx('send_attempts').where({id:attempt.id}).update({status:'reserved',reserved_at:now(),submitted_at:null,accepted_at:null,retryable:false,error_code:null,error_message:null,submission_count:Number(attempt.submission_count||0)+1});}
    let message=await trx('messages').where({attempt_id:attempt.id}).first(),headers:any={};
    if(!message){message={id:id(),account_id:account.id,contact_id:contact?.id||null,campaign_id:job.campaign_id||null,enrollment_id:job.enrollment_id||null,attempt_id:attempt.id,direction:'outbound',message_id:messageId,in_reply_to:payload.in_reply_to||null,references_json:JSON.stringify(payload.references||[]),from_email:account.email,to_email:recipient,subject:content.subject,body_text:content.body_text,body_html:content.body_html||null,campaign_sender_name:(version||payload).sender_name||null,campaign_reply_to:(version||payload).reply_to||null,classification:'outbound',is_test:!!payload.is_test,received_at:now(),created_at:now()};await trx('messages').insert(message);
      await saveMessageDetails(message,{from_name:message.campaign_sender_name||account.sender_name||settings.sender_name,to_name:contact?[contact.first_name,contact.last_name].filter(Boolean).join(' '):'',attachments:payload.is_manual===true?payload.attachments||[]:[]},trx);
      if(payload.is_manual===true){const tracking=await prepareManualTracking(message,payload.open_tracking===true,trx);message={...message,...tracking};await trx('messages').where({id:message.id}).update(tracking);}
      else if(!payload.is_reply){const marketing=await prepareMarketing(message,version||payload,settings,trx);headers=marketing.headers;message={...message,body_text:marketing.body_text,body_html:marketing.body_html};await trx('messages').where({id:message.id}).update({body_text:message.body_text,body_html:message.body_html,open_tracking:marketing.open_tracking,click_tracking:marketing.click_tracking});}
    }else if(!payload.is_reply&&payload.is_manual!==true){const unsub=await trx('tracking_tokens').where({message_id:message.id,kind:'unsubscribe'}).first();if(unsub){headers={'List-Unsubscribe':`<${config.appUrl.replace(/\/$/,'')}/unsubscribe/${unsub.id}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'};}}
    await trx('jobs').where({id:job.id}).update({attempts:job.attempts+1,updated_at:now()});
    return {job,attempt,account,contact,recipient,message,headers,settings,attachments:smtpAttachments(payload.is_manual===true?payload.attachments||[]:[])};
  });
}

async function markSubmitting(prepared:any) {
  return db.transaction(async trx=>{
    await trx('business_settings').where({id:'agency'}).forUpdate().first();
    const job=await trx('jobs').where({id:prepared.job.id}).forUpdate().first(),settings=await getSettings(trx),account=await trx('email_accounts').where({id:prepared.account.id}).first(),payload=json(job?.payload,{});
    let reason=job?.status!=='leased'||job.lease_owner!==prepared.job.lease_owner||new Date(job.lease_until)<=now()?'Job lease was cancelled or expired':await actualEligibility(trx,job,account,settings,payload);
    if(!reason&&payload.is_manual!==true&&nextSendingTime(now(),settings).getTime()>Date.now()+1000)reason='Sending window closed';
    if(reason){await trx('send_attempts').where({id:prepared.attempt.id}).update({status:'cancelled',retryable:false,error_message:reason});await recordOutcome(trx,prepared.attempt.id,'cancelled','ELIGIBILITY_CHANGED',reason);if(job?.status==='leased'){if(/^(?:Reply|Manual) recipient|suppressed|consent|valid recipient/i.test(reason))await cancelJob(trx,job,reason);else await delayJob(trx,job,reason);}return false;}
    await trx('send_attempts').where({id:prepared.attempt.id,status:'reserved'}).update({status:'submitting',submitted_at:now()});return true;
  });
}

export async function finishAccepted(attemptId:string,acceptedAt:Date=now(),existingTrx?:Database) {
  const run=async(trx:Database)=>{
    const attempt=await trx('send_attempts').where({id:attemptId}).forUpdate().first();if(!attempt)throw new HttpError(404,'Attempt not found.');
    await trx('send_attempts').where({id:attempt.id}).update({status:'accepted',retryable:false,accepted_at:acceptedAt,error_code:null,error_message:null});
    await recordOutcome(trx,attempt.id,'accepted');
    await trx('messages').where({attempt_id:attempt.id}).update({received_at:acceptedAt});
    const job=await trx('jobs').where({id:attempt.job_id}).first();await trx('jobs').where({id:job.id}).update({status:'completed',lease_owner:null,lease_until:null,last_error:null,updated_at:now()});
    if(attempt.enrollment_id){const enrollment=await trx('enrollments').where({id:attempt.enrollment_id}).forUpdate().first();if(enrollment&&enrollment.status==='active'){
      const nextPosition=Number(job.step_position)+1,next=await trx('sequence_steps').where({version_id:enrollment.version_id,position:nextPosition}).first();
      await trx('enrollments').where({id:enrollment.id}).update({next_step:nextPosition,last_accepted_at:acceptedAt,status:next?'active':'completed',updated_at:now()});
      if(next){const settings=await getSettings(trx);await trx('jobs').insert({id:id(),kind:'send',account_id:enrollment.account_id,campaign_id:enrollment.campaign_id,enrollment_id:enrollment.id,step_position:nextPosition,payload:JSON.stringify({}),status:'queued',due_at:followupTime(acceptedAt,next.delay_days,settings),attempts:0,created_at:now(),updated_at:now()}).onConflict(['enrollment_id','step_position']).ignore();}
      const stage=await trx('pipeline_stages').where({name:'Contacted'}).first(),newStage=await trx('pipeline_stages').where({name:'New'}).first();if(stage&&newStage)await trx('contacts').where({id:enrollment.contact_id,stage_id:newStage.id}).update({stage_id:stage.id,updated_at:now()});
    }
      const remaining=await trx('enrollments').where({campaign_id:attempt.campaign_id}).whereIn('status',['active','paused']).first();if(!remaining)await trx('campaigns').where({id:attempt.campaign_id}).whereIn('status',['active','scheduled']).update({status:'completed',updated_at:now()});
    }
  };
  return existingTrx?run(existingTrx):db.transaction(async trx=>{await trx('business_settings').where({id:'agency'}).forUpdate().first();return run(trx);});
}

async function sendJob(job:any,deadline:number) {
  const prepared=await reserveSend(job);if(!prepared)return;
  let transport:any,submissionStarted=false;
  try{
    // DNS/TLS target validation happens before the submission marker. If target
    // preparation fails, no SMTP submission occurred and a safe retry is possible.
    try{transport=await bounded(smtpTransport(prepared.account),Math.min(deadline-1000,Date.now()+4000),undefined,value=>value.close());}catch(error){Object.assign(error as object,{command:'CONN'});throw error;}
    if(Date.now()>deadline-1000)throw new Error('Worker budget expired before submission');
    if(!await markSubmitting(prepared))return;
    if(Date.now()>deadline-500)throw new Error('Worker budget expired before SMTP invocation');
    const message=prepared.message;
    submissionStarted=true;
    const result=await bounded<any>(transport.sendMail({
      from:{name:message.campaign_sender_name||prepared.account.sender_name||prepared.settings.sender_name,address:prepared.account.email},
      to:prepared.recipient,replyTo:message.campaign_reply_to||undefined,messageId:prepared.attempt.message_id,
      subject:message.subject,text:message.body_text,html:message.body_html||undefined,
      inReplyTo:message.in_reply_to||undefined,references:json(message.references_json,[]),headers:prepared.headers,
      attachments:prepared.attachments,
      disableFileAccess:true,disableUrlAccess:true,
    }),deadline-500,()=>transport.close());
    if(!result.accepted?.some((address:any)=>normalizeEmail(String(typeof address==='string'?address:address.address))===prepared.recipient)){const rejected:any=new Error('Recipient rejected');rejected.code='EENVELOPE';rejected.responseCode=550;throw rejected;}
    await finishAccepted(prepared.attempt.id,now());
  }catch(error){
    const outcome=submissionStarted?smtpFailure(error,{submissionStarted:true}):{status:'temporary' as const,retryable:true,code:'PRE_SUBMISSION',message:'Sending setup failed before SMTP submission. Verify the mailbox connection.'};
    await db.transaction(async trx=>{
      await trx('business_settings').where({id:'agency'}).forUpdate().first();
      const attempt=await trx('send_attempts').where({id:prepared.attempt.id}).forUpdate().first();if(attempt.status==='accepted')return;
      const currentJob=await trx('jobs').where({id:job.id}).first(),settings=await getSettings(trx),canRetry=outcome.retryable&&currentJob.attempts<=settings.max_retries;
      await trx('send_attempts').where({id:attempt.id}).update({status:outcome.status,retryable:canRetry,error_code:outcome.code,error_message:outcome.message});
      await recordOutcome(trx,attempt.id,outcome.status,outcome.code,outcome.message);
      await trx('jobs').where({id:job.id}).update({status:outcome.status==='unknown'?'held':canRetry?'queued':'failed',due_at:new Date(Date.now()+Math.min(3600000,60000*2**Math.min(currentJob.attempts,6))),lease_owner:null,lease_until:null,last_error:outcome.message,updated_at:now()});
      if(outcome.status==='auth')await trx('email_accounts').where({id:prepared.account.id}).update({status:'error',last_error:outcome.message,updated_at:now()});
      if(outcome.status==='permanent'&&prepared.contact?.id&&!prepared.attempt.is_test)await stopContact(prepared.contact.id,'Permanent SMTP rejection requires review','paused',trx);
    });
  }finally{transport?.close();}
}

export async function retryFailedJobs(actorId?:string) {
  return db.transaction(async trx=>{
    await trx('business_settings').where({id:'agency'}).forUpdate().first();
    const jobs=await trx('jobs').where({status:'failed'}).forUpdate().skipLocked();let retried=0;
    for(const job of jobs){const attempt=await trx('send_attempts').where({job_id:job.id}).first(),account=await trx('email_accounts').where({id:job.account_id}).first();if(!account||account.deleted_at)continue;if(job.kind==='sync'||(['temporary','auth','limit'].includes(attempt?.status)&&account?.status==='active'&&account?.verified_at)){
      await trx('jobs').where({id:job.id}).update({status:'queued',attempts:0,due_at:now(),lease_owner:null,lease_until:null,last_error:null,updated_at:now()});retried++;
    }}await audit(actorId,'queue.safe_retry','queue',null,{retried},trx);return {retried};
  });
}

export async function reconcileAttempt(attemptId:string,resolution:'accepted'|'not_sent',actorId:string,acceptedAt?:Date) {
  return db.transaction(async trx=>{
    await trx('business_settings').where({id:'agency'}).forUpdate().first();
    const attempt=await trx('send_attempts').where({id:attemptId}).forUpdate().first();if(!attempt)throw new HttpError(404,'Attempt not found.');if(attempt.status!=='unknown')throw new HttpError(409,'Only unknown attempts require reconciliation.');
    if(acceptedAt&&(Number.isNaN(acceptedAt.getTime())||acceptedAt>now()||acceptedAt<new Date(attempt.reserved_at)))throw new HttpError(400,'Verified acceptance time must be between reservation and now.');
    // When the provider's exact timestamp is unavailable, confirmation time is
    // conservative: it cannot bring a follow-up forward from the unknown send.
    if(resolution==='accepted')await finishAccepted(attempt.id,acceptedAt||now(),trx);
    else{await trx('send_attempts').where({id:attempt.id}).update({status:'cancelled',retryable:true,error_message:'Owner confirmed the message was not sent'});await recordOutcome(trx,attempt.id,'cancelled','OWNER_RECONCILED','Owner confirmed the message was not sent');await trx('jobs').where({id:attempt.job_id,status:'held'}).update({status:'queued',attempts:0,due_at:now(),lease_owner:null,lease_until:null,last_error:null,updated_at:now()});}
    await audit(actorId,'send.reconciled','send_attempt',attempt.id,{resolution,acceptance_time_source:acceptedAt?'provider_evidence':'confirmation_time',accepted_at:acceptedAt?.toISOString()},trx);return {reconciled:true,resolution};
  });
}

export async function runWorker(options:{budgetMs?:number;maxJobs?:number;syncOnly?:boolean;inboxOnly?:boolean}={}) {
  await ensureMailFeatures();
  const workerId=randomUUID(),deadline=Date.now()+Math.min(20000,Math.max(1000,options.budgetMs||15000));let processed=0;
  await db('worker_state').where({id:'scheduler'}).update({last_heartbeat:now(),last_error:null,updated_at:now()});
  await recoverExpiredLeases();const settings=await getSettings();await queueDueSync(settings);
  // Privacy retention removes raw engagement events only; suppression, consent,
  // versions and delivery history are retained for safety and auditability.
  await db('tracking_events').whereIn('kind',['open','click']).where('created_at','<',new Date(Date.now()-settings.retention_days*86400000)).delete();
  while(processed<Math.min(25,options.maxJobs||5)&&Date.now()<deadline-8000){
    const job=await claimJob(workerId,!!options.syncOnly,!!options.inboxOnly);if(!job)break;
    try{
      if(job.kind==='sync'){
        const account=await db('email_accounts').where({id:job.account_id}).first(),result=await syncMailbox(account,{deadline,maxMessages:50});
        await db('jobs').where({id:job.id,status:'leased',lease_owner:workerId}).update({status:result.complete?'completed':'queued',due_at:new Date(Date.now()+(result.complete?settings.poll_interval_seconds*1000:1000)),lease_owner:null,lease_until:null,last_error:null,updated_at:now()});
      }else await sendJob(job,deadline);
    }catch{
      // An unexpected crash after the submitting marker must never become a retry.
      await db.transaction(async trx=>{
        await trx('business_settings').where({id:'agency'}).forUpdate().first();
        const attempt=await trx('send_attempts').where({job_id:job.id}).first(),ambiguous=attempt&&['submitting','unknown'].includes(attempt.status);
        if(ambiguous){await trx('send_attempts').where({id:attempt.id}).update({status:'unknown',retryable:false,error_message:'Processing interrupted after submission began. Reconcile manually.'});await recordOutcome(trx,attempt.id,'unknown','PROCESSING_INTERRUPTED','Processing interrupted after submission began.');}
        await trx('jobs').where({id:job.id,status:'leased',lease_owner:workerId}).update({status:ambiguous?'held':'failed',lease_owner:null,lease_until:null,last_error:job.kind==='sync'?'Inbox sync failed. Verify connection settings; sending will pause if sync becomes stale.':'Job failed safely. Review system health before retrying.',updated_at:now()});
        if(job.kind==='sync')await trx('email_accounts').where({id:job.account_id}).update({last_error:'Inbox sync failed. Check IMAP connectivity and credentials privately.',updated_at:now()});
      });
      await db('worker_state').where({id:'scheduler'}).update({last_error:'A job failed. Review the queue and mailbox health.',updated_at:now()});
    }processed++;
  }
  return {processed,worker_id:workerId,budget_ms:Math.min(20000,options.budgetMs||15000)};
}
