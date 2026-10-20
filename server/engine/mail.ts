import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { decryptSecret } from '../lib/crypto.js';
import { validateMailTarget } from '../lib/mail-target.js';
import { db, json, type Database } from '../db.js';
import { id, normalizeEmail } from '../lib/util.js';
import { classifyIncoming, referenceIds, checkpointRange, sanitizeEmail, deliveryReports } from './content.js';
import { stopContact, suppressEmail } from './policy.js';

export async function smtpTransport(account: any) {
  const pinned=await validateMailTarget(account.smtp_host,account.smtp_port,'smtp');
  return nodemailer.createTransport({host:pinned.address,port:account.smtp_port,secure:account.smtp_security==='tls',requireTLS:true,auth:{user:account.smtp_username,pass:decryptSecret(account.smtp_secret)},tls:{servername:pinned.servername,rejectUnauthorized:true,minVersion:'TLSv1.2'},connectionTimeout:5000,greetingTimeout:5000,socketTimeout:7000,logger:false,debug:false,disableFileAccess:true,disableUrlAccess:true});
}

export async function imapClient(account: any) {
  const pinned=await validateMailTarget(account.imap_host,account.imap_port,'imap');
  return new ImapFlow({host:pinned.address,port:account.imap_port,secure:true,auth:{user:account.imap_username,pass:decryptSecret(account.imap_secret)},tls:{servername:pinned.servername,rejectUnauthorized:true,minVersion:'TLSv1.2'},logger:false,connectionTimeout:5000,greetingTimeout:5000,socketTimeout:7000,disableAutoIdle:true,emitLogs:false});
}

export async function findReply(parsed: any, accountId: string, trx: Database = db) {
  const refs=referenceIds(parsed);
  // Bounces commonly put the original Message-ID inside the delivery report.
  const original=String(parsed.headers?.get('original-message-id')||'');if(original)refs.push(original);
  const attachmentText=(parsed.attachments||[]).filter((a:any)=>['message/delivery-status','message/rfc822'].includes(a.contentType)).map((a:any)=>a.content?.toString('utf8')||'').join('\n');
  if(classifyIncoming(parsed)==='delivery_failure')for(const match of attachmentText.matchAll(/^message-id:\s*(<[^>]+>)/gim))refs.push(match[1]);
  if(!refs.length)return null;
  const outbound=await trx('messages').where({account_id:accountId,direction:'outbound'}).whereIn('message_id',[...new Set(refs)]);
  if(!outbound.length)return null;
  // A normal one-to-one message may have no CRM contact. Header references must
  // still resolve to one external participant within the original mailbox.
  const recipients=new Set(outbound.map(m=>normalizeEmail(m.to_email)));
  if(recipients.size!==1)return null;
  return outbound.sort((a,b)=>new Date(b.received_at).getTime()-new Date(a.received_at).getTime())[0];
}

export async function ingestIncoming(account: any, parsed: any, uid: number, uidValidity: string, trx: Database) {
  let messageId=String(parsed.messageId||`<imap-${account.id}-${uidValidity}-${uid}@crm.invalid>`).slice(0,254);
  if(!messageId.trim())messageId=`<imap-${account.id}-${uidValidity}-${uid}@crm.invalid>`;
  const existing=await trx('messages').where({account_id:account.id,message_id:messageId}).first();if(existing)return {duplicate:true,message:existing};
  const matched=await findReply(parsed,account.id,trx),sender=normalizeEmail(parsed.from?.value?.[0]?.address||'unknown@invalid.invalid');
  const senderContact=await trx('contacts').where({email:sender}).first();
  let classification=classifyIncoming(parsed),contactId=senderContact?.id||null;
  if(!matched){
    classification=classification==='human_reply'?(contactId?'uncertain':'unmatched'):classification;
  }else if(classification==='human_reply'){
    if(normalizeEmail(matched.to_email)!==sender)classification='uncertain';
  }
  if(classification==='delivery_failure'&&matched){const recipientContact=await trx('contacts').where({email:normalizeEmail(matched.to_email)}).first();contactId=recipientContact?.id||null;}
  if(classification==='delivery_failure'&&(!matched||!deliveryReports(parsed).some(report=>report.recipient===normalizeEmail(matched.to_email)&&report.status.startsWith('5.'))))classification='uncertain';
  const message={id:id(),account_id:account.id,contact_id:contactId,campaign_id:matched?.campaign_id||null,enrollment_id:matched?.enrollment_id||null,direction:'inbound',message_id:messageId,in_reply_to:parsed.inReplyTo?String(parsed.inReplyTo).slice(0,254):null,references_json:JSON.stringify(referenceIds(parsed).slice(-100)),from_email:sender,to_email:account.email,subject:String(parsed.subject||'(No subject)').slice(0,998),body_text:String(parsed.text||'').slice(0,200000),body_html:parsed.html?sanitizeEmail(String(parsed.html).slice(0,300000)):null,classification,is_test:!!matched?.is_test,received_at:parsed.date instanceof Date&&!Number.isNaN(parsed.date.getTime())?parsed.date:new Date(),created_at:new Date()};
  await trx('messages').insert(message);
  if(contactId&&classification==='human_reply'){
    await stopContact(contactId,'Human reply detected: agency-wide outreach stopped','stopped',trx);
    const stage=await trx('pipeline_stages').where({name:'Replied'}).first();
    if(stage)await trx('contacts').where({id:contactId}).whereIn('stage_id',trx('pipeline_stages').select('id').whereIn('name',['New','Contacted'])).update({stage_id:stage.id,updated_at:new Date()});
  }else if(contactId&&['automatic','uncertain'].includes(classification))await stopContact(contactId,`${classification} reply requires review`,'paused',trx);
  if(classification==='delivery_failure'&&matched){
    const permanent=deliveryReports(parsed).some(report=>report.recipient===normalizeEmail(matched.to_email)&&report.status.startsWith('5.'));
    await trx('tracking_events').insert({id:id(),message_id:matched.id,campaign_id:matched.campaign_id,contact_id:contactId,kind:'bounce',bot:false,created_at:new Date()});
    if(permanent)await suppressEmail(matched.to_email,'permanent_bounce','matched delivery status report',null,trx);
    else if(contactId)await stopContact(contactId,'Delivery report requires review','paused',trx);
  }
  return {duplicate:false,message};
}

export async function syncMailbox(account: any, options: {deadline?:number; maxMessages?:number; client?:any} = {}) {
  const client=options.client||await imapClient(account),deadline=options.deadline||Date.now()+15000;
  let lock:any,processed=0,complete=true;
  const deadlineTimer=setTimeout(()=>client.close(),Math.max(1,deadline-Date.now()-500));
  client.on('error',()=>{}); // Prevent unhandled socket events; operations surface sanitized errors to worker.
  try{
    // A failed or partially caught-up generation is never considered fresh,
    // even if a previous generation completed only moments ago.
    await db('email_accounts').where({id:account.id}).update({last_sync_at:null,updated_at:new Date()});
    await client.connect();lock=await client.getMailboxLock('INBOX');
    const validity=String(client.mailbox.uidValidity),checkpoint=await db('mailbox_checkpoints').where({account_id:account.id,folder:'INBOX'}).first(),start=checkpointRange(checkpoint,validity);
    const uidNext=Number(client.mailbox.uidNext||1),metadata:any[]=[];
    const found=start<uidNext?await client.search({uid:`${start}:${uidNext-1}`},{uid:true}):[];
    if(!Array.isArray(found))throw new Error('IMAP UID search did not complete');
    const available:number[]=[...new Set<number>(found.filter((uid:number)=>uid>=start&&uid<uidNext))].sort((a,b)=>a-b),selected=available.slice(0,options.maxMessages||50),selectedSet=new Set(selected);
    complete=selected.length===available.length;
    const end=complete?uidNext-1:selected[selected.length-1];
    // SEARCH discovers present UIDs without scanning millions of expunged IDs.
    // Consume the lowest bounded batch even when FETCH arrives out of order.
    if(selected.length){for await(const item of client.fetch(selected.join(','),{uid:true,size:true,envelope:true,headers:true},{uid:true})){if(selectedSet.has(item.uid))metadata.push(item);}}
    metadata.sort((a,b)=>a.uid-b.uid);
    for(const item of metadata){
      if(Date.now()>deadline-3000){complete=false;break;}
      let parsed:any;
      if(item.size>2_000_000){parsed={messageId:item.envelope?.messageId,from:{value:item.envelope?.from||[]},subject:item.envelope?.subject||'',date:item.envelope?.date,headers:new Map([['auto-submitted','auto-generated']]),text:'Large message was not downloaded. Review it in the mailbox; attachments are deferred.'};}
      else{const full=await client.fetchOne(item.uid,{source:true},{uid:true});if(!full||!full.source)throw new Error('IMAP message disappeared before checkpoint');parsed=await simpleParser(full.source,{skipHtmlToText:true,skipTextToHtml:true,maxHtmlLengthToParse:300000});}
      await db.transaction(async trx=>{
        // Global send lock ensures detected replies are applied before any later reservation.
        await trx('business_settings').where({id:'agency'}).forUpdate().first();
        await ingestIncoming(account,parsed,item.uid,validity,trx);
        await trx('mailbox_checkpoints').insert({id:checkpoint?.id||id(),account_id:account.id,folder:'INBOX',uid_validity:validity,last_uid:item.uid,updated_at:new Date()}).onConflict(['account_id','folder']).merge(['uid_validity','last_uid','updated_at']);
      });processed++;
    }
    if(processed<metadata.length)complete=false;
    if(processed===metadata.length){
      // Expunged UIDs and empty chunks still advance durable progress. Freshness
      // is restored only after the entire captured UID generation is consumed.
      await db.transaction(async trx=>{await trx('mailbox_checkpoints').insert({id:checkpoint?.id||id(),account_id:account.id,folder:'INBOX',uid_validity:validity,last_uid:Math.max(0,end),updated_at:new Date()}).onConflict(['account_id','folder']).merge(['uid_validity','last_uid','updated_at']);if(complete)await trx('email_accounts').where({id:account.id}).update({last_sync_at:new Date(),last_successful_sync_at:new Date(),last_error:null,updated_at:new Date()});});
    }
    return {processed,complete};
  }finally{lock?.release();try{await client.logout();}catch{client.close();}finally{clearTimeout(deadlineTimer);}}
}
