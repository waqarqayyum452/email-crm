import sanitize from 'sanitize-html';
export function sanitizeEmail(html: string, remoteImages = false) {
  return sanitize(html, {
    allowedTags: ['p','br','b','strong','em','i','u','s','blockquote','ul','ol','li','a','h1','h2','h3','h4','table','thead','tbody','tr','td','th','hr','div','span',...(remoteImages?['img']:[])],
    allowedAttributes: {a:['href','title','rel','target'],...(remoteImages?{img:['src','alt','width','height']}:{}),td:['colspan','rowspan'],th:['colspan','rowspan']},
    allowedSchemes:['https','http','mailto'], allowProtocolRelative:false,
    transformTags:{a:(_tag,attrs)=>({tagName:'a',attribs:{...attrs,rel:'noopener noreferrer nofollow',target:'_blank'}})},
  });
}
