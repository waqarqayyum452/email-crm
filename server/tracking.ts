import { sanitizeFormattedEmail } from './lib/html.js';
import { randomBytes } from 'node:crypto';
import { Router, type Request } from './http.js';
import { db, type Database } from './db.js';
import { config } from './config.js';
import { id, HttpError } from './lib/util.js';
import { getSettings } from './settings.js';
import { suppressEmail } from './engine/policy.js';
import { botLike, escapeHtml, safeDestination, sanitizeEmail } from './engine/content.js';

const token = () => randomBytes(32).toString('hex');
const base = () => config.appUrl.replace(/\/$/,'');
const PIXEL=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
export function trackingUrl(kind:'open'|'click',value:string) { return `${base()}/t/${kind}/${value}${kind==='open'?'.gif':''}`; }

export async function prepareManualTracking(message:any, enabled:boolean, trx:Database) {
  if(!enabled)return {body_html:message.body_html,open_tracking:false};
  const trackingToken=token();
  await trx('tracking_tokens').insert({id:trackingToken,message_id:message.id,campaign_id:message.campaign_id||null,contact_id:message.contact_id||null,kind:'tracking',created_at:new Date()});
  const html=message.body_html?sanitizeFormattedEmail(message.body_html,'cid'):'<div>'+escapeHtml(message.body_text).replace(/\n/g,'<br>')+'</div>';
  return {body_html:html+`<img src="${trackingUrl('open',trackingToken)}" width="1" height="1" alt="">`,open_tracking:true};
}

export async function prepareMarketing(message: any, options: {open_tracking?:boolean;click_tracking?:boolean}, settings: any, trx: Database) {
  const unsubscribeToken=token(),trackingToken=token(),now=new Date();
  const openTracking=!!options.open_tracking&&!message.is_test,clickTracking=!!options.click_tracking&&!message.is_test;
  const tokens=[{id:unsubscribeToken,message_id:message.id,campaign_id:message.campaign_id,contact_id:message.contact_id,kind:'unsubscribe',created_at:now}];
  if(openTracking||clickTracking)tokens.push({id:trackingToken,message_id:message.id,campaign_id:message.campaign_id,contact_id:message.contact_id,kind:'tracking',created_at:now});
  await trx('tracking_tokens').insert(tokens);
  const unsubscribeUrl=`${base()}/unsubscribe/${unsubscribeToken}`,links:any[]=[];
  const rewrite=(url:string)=>{const destination=safeDestination(url);if(!clickTracking||!destination||destination.startsWith(`${base()}/unsubscribe/`))return url;const linkToken=token();links.push({id:id(),token:linkToken,message_id:message.id,campaign_id:message.campaign_id,url:destination,created_at:now});return trackingUrl('click',linkToken);};
  let text=String(message.body_text).replace(/https?:\/\/[^\s<>"']+/gi, (url:string)=>{const trailing=url.match(/[.,;!?)]+$/)?.[0]||'';return rewrite(trailing?url.slice(0,-trailing.length):url)+trailing;});
  let html=message.body_html?sanitizeEmail(message.body_html,false,rewrite):null;
  const signature=String(settings.signature||'').trim(),address=String(settings.business_address||'').trim(),copy=String(settings.unsubscribe_copy||'Unsubscribe from these emails').trim();
  text+=`${signature?'\n\n'+signature:''}\n\n${address}\n${copy}: ${unsubscribeUrl}`;
  if(html)html+=`${signature?'<p>'+escapeHtml(signature).replace(/\n/g,'<br>')+'</p>':''}<p>${escapeHtml(address)}</p><p><a href="${unsubscribeUrl}">${escapeHtml(copy)}</a></p>`;
  // Tracking requires an HTML part even when the campaign was composed in plain text.
  if(openTracking){if(!html)html='<div>'+escapeHtml(text).replace(/\n/g,'<br>')+'</div>';html+=`<img src="${trackingUrl('open',trackingToken)}" width="1" height="1" alt="">`;}
  if(links.length)await trx('tracked_links').insert(links);
  return {body_text:text,body_html:html,open_tracking:openTracking,click_tracking:clickTracking,headers:{'List-Unsubscribe':`<${unsubscribeUrl}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}};
}

function validToken(value:unknown): value is string { return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value); }
async function event(req:Request,row:any,kind:'open'|'click',linkId?:string){await db('tracking_events').insert({id:id(),message_id:row.message_id,campaign_id:row.campaign_id,contact_id:row.contact_id||null,kind,link_id:linkId||null,bot:botLike(req.get('user-agent')||''),created_at:new Date()});}
export const publicRouter=Router();
publicRouter.get('/t/open/:token.gif',async(req,res)=>{
  res.set({'Cache-Control':'no-store, no-cache, must-revalidate','Pragma':'no-cache','Content-Type':'image/gif'});
  const value=req.params.token;
  if(validToken(value)){const row=await db('tracking_tokens').where({id:value,kind:'tracking'}).first();if(row)await event(req,row,'open');}
  res.send(PIXEL);
});
publicRouter.get('/t/click/:token',async(req,res)=>{
  if(!validToken(req.params.token))throw new HttpError(404,'Link not found.');
  const row=await db('tracked_links').where({token:req.params.token}).first(),destination=row?safeDestination(row.url):null;
  if(!row||!destination)throw new HttpError(404,'Link is unavailable.');
  const message=await db('messages').where({id:row.message_id}).first();
  await event(req,{...row,contact_id:message?.contact_id},'click',row.id);res.set('Cache-Control','no-store').redirect(302,destination);
});
publicRouter.get('/unsubscribe/:token',async(req,res)=>{
  if(!validToken(req.params.token)||!await db('tracking_tokens').where({id:req.params.token,kind:'unsubscribe'}).first())throw new HttpError(404,'Unsubscribe link not found.');
  const settings=await getSettings();
  res.set({'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"}).type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Unsubscribe</title><style>body{font:17px system-ui;max-width:36rem;margin:12vh auto;padding:24px;color:#182d31}button{background:#153e45;color:white;border:0;padding:14px 24px;border-radius:8px;cursor:pointer}</style><h1>Unsubscribe</h1><p>Stop marketing emails from ${escapeHtml(settings.agency_name)}.</p><form method="post"><input type="hidden" name="confirmed" value="true"><button type="submit">Confirm unsubscribe</button></form><p>No sign-in is required.</p></html>`);
});
publicRouter.post('/unsubscribe/:token',async(req,res)=>{
  if(!validToken(req.params.token))throw new HttpError(404,'Unsubscribe link not found.');
  if(req.body?.confirmed!=='true'&&req.body?.confirmed!==true&&req.body?.['List-Unsubscribe']!=='One-Click')throw new HttpError(400,'Please confirm the unsubscribe request.');
  await db.transaction(async trx=>{
    const row=await trx('tracking_tokens').where({id:req.params.token,kind:'unsubscribe'}).first();if(!row)throw new HttpError(404,'Unsubscribe link not found.');
    const message=await trx('messages').where({id:row.message_id}).first();if(!message)throw new HttpError(404,'Unsubscribe link not found.');
    await suppressEmail(message.to_email,'unsubscribe','public unsubscribe',null,trx);
    if(!await trx('tracking_events').where({message_id:row.message_id,kind:'unsubscribe'}).first())await trx('tracking_events').insert({id:id(),message_id:row.message_id,campaign_id:row.campaign_id,contact_id:row.contact_id,kind:'unsubscribe',bot:false,created_at:new Date()});
  });
  if(req.body?.['List-Unsubscribe']==='One-Click')res.json({unsubscribed:true});
  else res.set('Cache-Control','no-store').type('html').send('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Unsubscribed</title><body style="font:17px system-ui;max-width:36rem;margin:12vh auto;padding:24px"><h1>You are unsubscribed</h1><p>Your address is now suppressed across all connected mailboxes.</p></body></html>');
});
