import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {Router} from './http.js';
import {db,json,type Database} from './db.js';
import {up} from './migrations/010_campaign_designs.js';
import {requireUser,permit,consumeRateLimit} from './auth.js';
import {encryptSecret,decryptSecret} from './lib/crypto.js';
import {rasterType} from './engine/mail-features.js';
import {sanitizeFormattedEmail} from './lib/html.js';
import {designSchema,buildDesignedEmail} from '../shared/campaign-design.js';
import {config} from './config.js';
import {HttpError,audit} from './lib/util.js';
let provision:Promise<void>|undefined;
export function ensureCampaignDesigns(){return provision??=up(db).catch(e=>{provision=undefined;throw e;});}
export function cleanDesign(value:unknown){const design=designSchema.parse(json(value,null));return {...design,blocks:design.blocks.map(b=>b.type==='heading'||b.type==='paragraph'?{...b,html:sanitizeFormattedEmail(b.html)}:b)};}
export async function normalizeCampaignDraft<T extends {email_type?:string;steps:any[];open_tracking?:boolean}>(draft:T,trx:Database=db):Promise<T>{
 for(const step of draft.steps){if(step.design&&draft.email_type!=='plain'){step.design=cleanDesign(step.design);const assets:string[]=step.design.blocks.filter((b:any)=>b.type==='image'&&b.asset_id).map((b:any)=>b.asset_id);if(assets.length){const present=await trx('campaign_images').whereIn('id',[...new Set(assets)]);if(present.length!==new Set(assets).size)throw new HttpError(400,'A design image is missing. Upload it again.');}const rendered=buildDesignedEmail(step.design,config.appUrl,step.preview_text||'');if(rendered.body_html.length>200000||rendered.body_text.length>100000)throw new HttpError(400,'This design is too large. Shorten the content or use fewer blocks.');Object.assign(step,rendered);}if(draft.email_type==='plain'){step.design=null;step.body_html=null;} }
 if(draft.email_type==='plain')draft.open_tracking=false;
 return draft;
}
export function assertCampaignReady(draft:any){for(const step of draft.steps){if(!step.subject.trim()||!step.body_text.trim())throw new HttpError(400,'Every email needs a subject and message before previewing, testing or launching.');if(draft.email_type==='designed'&&!step.design)throw new HttpError(400,'Every designed email needs a saved design.');if(step.design?.blocks.some((b:any)=>b.type==='image'&&!b.asset_id||b.type==='button'&&!b.href))throw new HttpError(400,'Upload each image and provide a destination for each button.');}}
export const campaignImageRouter=Router();campaignImageRouter.use(requireUser,permit('campaigns:write'));
campaignImageRouter.post('/',async(req,res)=>{await consumeRateLimit('campaign-image:'+req.user!.id,30,60000);const input=z.object({content_base64:z.string().max(2800000),content_type:z.enum(['image/png','image/jpeg','image/gif','image/webp'])}).strict().parse(req.body);const bytes=Buffer.from(input.content_base64,'base64');if(!bytes.length||bytes.length>2*1024*1024||bytes.toString('base64')!==input.content_base64||rasterType(bytes)!==input.content_type)throw new HttpError(400,'Upload a valid PNG, JPEG, GIF or WebP image up to 2 MB.');await ensureCampaignDesigns();const key=randomBytes(32).toString('hex');await db.transaction(async trx=>{await trx('campaign_images').insert({id:key,content_type:input.content_type,encrypted_content:encryptSecret(input.content_base64),size:bytes.length,created_at:new Date()});await audit(req.user!.id,'campaign.image_uploaded','campaign_image',key,{size:bytes.length},trx);});res.status(201).json({id:key,url:config.appUrl.replace(/\/$/,'')+'/email-images/'+key});});
export const campaignImagePublicRouter=Router();
campaignImagePublicRouter.get('/email-images/:id',async(req,res)=>{if(!/^[a-f0-9]{64}$/.test(req.params.id))throw new HttpError(404,'Image not found.');await ensureCampaignDesigns();const row=await db('campaign_images').where({id:req.params.id}).first();if(!row)throw new HttpError(404,'Image not found.');res.set({'Content-Type':row.content_type,'Cache-Control':'public, max-age=31536000, immutable','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'cross-origin','Content-Security-Policy':"default-src 'none'"}).send(Buffer.from(decryptSecret(row.encrypted_content),'base64'));});
