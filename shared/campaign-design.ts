import { z } from 'zod';
const color=z.string().regex(/^#[a-fA-F0-9]{6}$/);
const align=z.enum(['left','center','right']);
const url=z.string().max(2048).refine(v=>!v||(()=>{try{const u=new URL(v);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}})(),'Use an absolute HTTP or HTTPS URL.');
const common={id:z.string().min(1).max(80),spacing:z.number().int().min(0).max(100).default(16)};
export const blockSchema=z.discriminatedUnion('type',[
 z.object({...common,type:z.literal('heading'),html:z.string().max(30000),color:color.default('#101828'),font_size:z.number().int().min(12).max(48).default(28),align:align.default('left')}),
 z.object({...common,type:z.literal('paragraph'),html:z.string().max(60000),color:color.default('#344054'),font_size:z.number().int().min(12).max(48).default(16),align:align.default('left')}),
 z.object({...common,type:z.literal('image'),asset_id:z.string().regex(/^[a-f0-9]{64}$/).or(z.literal('')),alt:z.string().max(500).default(''),width:z.number().int().min(40).max(900).default(560),align:align.default('center'),href:url.default('')}),
 z.object({...common,type:z.literal('button'),label:z.string().max(500).default('Learn more'),href:url.default('https://example.com'),background:color.default('#3863ff'),color:color.default('#ffffff'),align:align.default('center')}),
 z.object({...common,type:z.literal('divider'),color:color.default('#dce5f1')}),
 z.object({...common,type:z.literal('spacer'),height:z.number().int().min(4).max(200).default(24)})
]);
export const designSchema=z.object({version:z.literal(1),background:color.default('#f3f6fa'),content_background:color.default('#ffffff'),width:z.number().int().min(320).max(800).default(600),padding:z.number().int().min(0).max(80).default(24),blocks:z.array(blockSchema).max(60)}).strict();
export type Design=z.infer<typeof designSchema>;export type DesignBlock=z.infer<typeof blockSchema>;
export const escapeDesign=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function emptyDesign():Design{return {version:1,background:'#f3f6fa',content_background:'#ffffff',width:600,padding:24,blocks:[]};}
export function textFromHtml(html:string){return html.replace(/<br\s*\/?\s*>/gi,'\n').replace(/<\/(?:p|div|h[1-6]|li|blockquote|tr)>/gi,'\n\n').replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,(_a,url,label)=>label+' ('+url+')').replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&').replace(/\n{3,}/g,'\n\n').trim();}
/** Only rich text blocks contain HTML; sanitize them before calling this shared renderer. */
export function buildDesignedEmail(design:Design,origin:string,previewText=''){
 const text:string[]=[];
 const rows=design.blocks.map(b=>{let html='';
  if(b.type==='heading'||b.type==='paragraph'){text.push(textFromHtml(b.html));html='<div style="font-family:Arial,Helvetica,sans-serif;font-size:'+b.font_size+'px;line-height:1.5;color:'+b.color+';text-align:'+b.align+'">'+b.html+'</div>';}
  if(b.type==='image'&&b.asset_id){const imageWidth=Math.min(b.width,design.width-design.padding*2);const src=origin.replace(/\/$/,'')+'/email-images/'+b.asset_id;text.push((b.alt||'Image')+': '+src+(b.href?' ('+b.href+')':''));const image='<img src="'+escapeDesign(src)+'" width="'+imageWidth+'" alt="'+escapeDesign(b.alt)+'" style="display:block;border-width:0;width:100%;max-width:'+imageWidth+'px;height:auto">';html='<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="'+b.align+'" style="width:100%;max-width:'+b.width+'px"><tr><td>'+ (b.href?'<a href="'+escapeDesign(b.href)+'">'+image+'</a>':image)+'</td></tr></table>';}
  if(b.type==='button'){text.push(b.label+(b.href?' ('+b.href+')':''));html='<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="'+b.align+'"><tr><td bgcolor="'+b.background+'" style="background-color:'+b.background+';padding:14px 24px;text-align:center"><a href="'+escapeDesign(b.href)+'" style="font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:'+b.color+';text-decoration:none;display:inline-block">'+escapeDesign(b.label)+'</a></td></tr></table>';}
  if(b.type==='divider')html='<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top-style:solid;border-top-width:1px;border-top-color:'+b.color+';font-size:1px;line-height:1px">&nbsp;</td></tr></table>';
  if(b.type==='spacer')html='<div style="height:'+b.height+'px;line-height:'+b.height+'px;font-size:1px">&nbsp;</div>';
  return '<tr><td style="padding:0 0 '+b.spacing+'px;text-align:'+('align' in b?b.align:'left')+'">'+html+'</td></tr>';
 }).join('');
 const preheader=previewText?'<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">'+escapeDesign(previewText)+'</div>':'';
 return {body_text:text.filter(Boolean).join('\n\n'),body_html:preheader+'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="'+design.background+'" style="width:100%;background-color:'+design.background+'"><tr><td align="center" style="padding:16px 0"><table role="presentation" width="'+design.width+'" cellpadding="0" cellspacing="0" border="0" bgcolor="'+design.content_background+'" style="width:100%;max-width:'+design.width+'px;background-color:'+design.content_background+'"><tr><td style="padding:'+design.padding+'px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'+rows+'</table></td></tr></table></td></tr></table>'};
}
