import sanitize from 'sanitize-html';
import { emailStyles, emailTags, cidPattern } from '../../shared/email-format.js';
export type ImagePolicy = 'none' | 'cid' | 'stored';
export function sanitizeFormattedEmail(html: string, images: ImagePolicy = 'none', imageSource?: (source:string)=>string|null, rewrite?: (url:string)=>string) {
  return sanitize(html, {
    allowedTags:[...emailTags,...(images!=='none'?['img']:[])],
    allowedAttributes:{'*':['style','dir','role','aria-hidden'],a:['href','title','rel','target','style'],img:['src','alt','width','height','style'],table:['width','height','cellpadding','cellspacing','border','align','bgcolor','style'],td:['colspan','rowspan','width','height','align','valign','bgcolor','style'],th:['colspan','rowspan','width','align','style'],font:['color','face','size','style']},
    allowedStyles:{'*':emailStyles}, allowedSchemes:['https','http','mailto'],allowedSchemesByTag:{img:['https','http','cid']},allowProtocolRelative:false,
    transformTags:{
      a:(_tag,attrs)=>({tagName:'a',attribs:{...attrs,...(attrs.href&&rewrite?{href:rewrite(attrs.href)}:{}),style:(attrs.style?attrs.style.replace(/(?:^|;)\s*text-decoration\s*:[^;]*/gi,'')+';':'')+'text-decoration:underline',rel:'noopener noreferrer nofollow',target:'_blank'}}),
      img:(_tag,attrs)=>{const source=attrs.src||'',cid=source.startsWith('cid:')&&cidPattern.test(source.slice(4));const allowed=cid||(images==='stored'&&/^https?:\/\//i.test(source));const src=allowed?(imageSource?imageSource(source):source):null;return {tagName:src?'img':'span',attribs:src?{...attrs,src}:{}};},
    },
  });
}
export function sanitizeEmail(html:string,remoteImages=false){return sanitizeFormattedEmail(html,remoteImages?'stored':'none');}
