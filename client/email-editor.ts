import { cidPattern, editorParagraphStyle, emailStyles, emailTags } from '../shared/email-format';

export const escapeEmailText=(text:string)=>text.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
export const textEmailHtml=(text:string)=>escapeEmailText(text).replace(/\r\n?/g,'\n').replace(/ {2}/g,' &nbsp;').replace(/\n/g,'<br>');
export function safeEditorHtml(html:string,keepCid=false){
  const document=new DOMParser().parseFromString(html,'text/html');
  for(const element of [...document.body.querySelectorAll('*')]){
    const tag=element.tagName.toLowerCase();
    if(['script','style','iframe','object','embed','svg','math','form','input','button','meta','link'].includes(tag)){element.remove();continue;}
    if(tag==='img'){
      const source=element.getAttribute('src')||'';
      if(!keepCid||!source.startsWith('cid:')||!cidPattern.test(source.slice(4))){element.remove();continue;}
    }else if(!emailTags.includes(tag)){element.replaceWith(...element.childNodes);continue;}
    const style=(element as HTMLElement).style;
    const safeStyle=Object.entries(emailStyles).flatMap(([property,patterns])=>{const value=style?.getPropertyValue(property)||'';return patterns.some(pattern=>pattern.test(value))?[property+':'+value]:[];}).join(';');
    for(const attribute of [...element.attributes]){
      if(attribute.name==='style')continue;
      if(tag==='a'&&attribute.name==='href'){
        try{const url=new URL(attribute.value);if(['http:','https:','mailto:'].includes(url.protocol)&&!url.username&&!url.password)continue;}catch{}
      }
      if(tag==='img'&&['src','alt','width','height'].includes(attribute.name))continue;
      if(['td','th'].includes(tag)&&['colspan','rowspan'].includes(attribute.name)&&/^\d{1,3}$/.test(attribute.value))continue;
      element.removeAttribute(attribute.name);
    }
    if(safeStyle)element.setAttribute('style',safeStyle);else element.removeAttribute('style');
    if(tag==='a')(element as HTMLElement).style.textDecoration='underline';
    if(tag==='p'&&!style.margin)style.cssText+=';'+editorParagraphStyle;
  }
  return document.body.innerHTML;
}

export function editorHtml(node:HTMLElement){
  const clone=node.cloneNode(true) as HTMLElement;
  for(const image of clone.querySelectorAll<HTMLImageElement>('img')){
    const cid=image.dataset.mailCid;
    if(cid&&cidPattern.test(cid)){image.setAttribute('src','cid:'+cid);image.removeAttribute('data-mail-cid');}else image.remove();
  }
  linkifyEmailText(clone);
  return safeEditorHtml(clone.innerHTML,true).replace(/\u200b/g,'');
}

export function linkifyEmailText(root:HTMLElement){
  const document=root.ownerDocument,walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),nodes:Text[]=[];
  while(walker.nextNode())nodes.push(walker.currentNode as Text);
  for(const text of nodes){
    if(text.parentElement?.closest('a,pre,code'))continue;
    const matches=[...text.data.matchAll(/(?:https?:\/\/|www\.)[^\s<>]+/gi)];if(!matches.length)continue;
    const fragment=document.createDocumentFragment();let offset=0;
    for(const match of matches){const value=match[0].replace(/[.,!?;:]+$/g,'');let href:string;try{const url=new URL(value.startsWith('www.')?'https://'+value:value);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)continue;href=url.href;}catch{continue;}
      fragment.append(document.createTextNode(text.data.slice(offset,match.index)));const link=document.createElement('a');link.href=href;link.textContent=value;link.style.cssText='text-decoration:underline;color:#1a56b0';fragment.append(link);offset=match.index!+value.length;
    }
    if(offset){fragment.append(document.createTextNode(text.data.slice(offset)));text.replaceWith(fragment);}
  }
}
