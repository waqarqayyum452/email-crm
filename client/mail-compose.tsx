'use client';

import { useEffect, useRef, useState } from 'react';
import { Bold, Italic, Underline, Link2, List, Paperclip, X, Send, Save, PenLine, Eye, Trash2, ImagePlus } from 'lucide-react';
import { api, body, patch, type Row } from './api';
import { useWorkspace } from './context';
import { Button, Field, FormError, Modal } from './ui';
import { editorHtml, safeEditorHtml, textEmailHtml, linkifyEmailText } from './email-editor';

export const fileSize = (bytes: number) => bytes >= 1024*1024 ? `${(bytes/1024/1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes/1024))} KB`;

function RichMessage({ text, html, inlineImages, onImages, onChange }: { text: string; html?: string; inlineImages: Row[]; onImages: (files: File[]) => Promise<Row[]>; onChange: (text: string, html: string) => void }) {
  const editor = useRef<HTMLDivElement>(null), selection = useRef<Range | null>(null);
  const [link, setLink] = useState<string | null>(null); const imageInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editor.current) {
    editor.current.innerHTML = safeEditorHtml(html || textEmailHtml(text),true);
    for(const image of editor.current.querySelectorAll<HTMLImageElement>('img')){const cid=(image.getAttribute('src')||'').slice(4),file=inlineImages.find(file=>file.cid===cid);if(file){image.dataset.mailCid=cid;image.src='data:'+file.content_type+';base64,'+file.content_base64;}else image.remove();}
  } }, []);
  const change = () => { const node = editor.current; if (node) onChange((node.innerText.replace(/\u200b/g, '').trim() ? node.innerText.replace(/\u200b/g, '') : node.querySelector('img') ? '[Inline image]' : ''), editorHtml(node)); };
  const remember = () => { const selected = window.getSelection(); if (selected?.rangeCount && editor.current?.contains(selected.anchorNode)) selection.current = selected.getRangeAt(0).cloneRange(); };
  const insert = (tag: string, href?: string) => {
    const node = editor.current; if (!node) return;
    node.focus(); const range = selection.current || document.createRange();
    if (!selection.current || !node.contains(range.commonAncestorContainer)) { range.selectNodeContents(node); range.collapse(false); }
    const parent=range.startContainer.nodeType===Node.ELEMENT_NODE?range.startContainer as Element:range.startContainer.parentElement;
    const active=['strong','em','u'].includes(tag)?parent?.closest(tag):null;
    if(active&&node.contains(active)&&active.contains(range.endContainer)){
      const children=[...active.childNodes];active.replaceWith(...children);
      if(children.length){range.setStartBefore(children[0]);range.setEndAfter(children[children.length-1]);const selected=window.getSelection();selected?.removeAllRanges();selected?.addRange(range);selection.current=range.cloneRange();}
      change();return;
    }
    const element = document.createElement(tag);
    if (href) { element.setAttribute('href', href); element.setAttribute('style','text-decoration:underline;color:#1a56b0'); element.textContent = range.toString() || href; range.deleteContents(); }
    else if (tag === 'ul') { const line = document.createElement('li'); line.textContent = range.toString() || '\u200b'; range.deleteContents(); element.append(line); }
    else { element.append(range.extractContents()); if (!element.textContent) element.textContent = '\u200b'; }
    range.insertNode(element); range.selectNodeContents(element); range.collapse(false);
    const selected = window.getSelection(); selected?.removeAllRanges(); selected?.addRange(range); selection.current = range.cloneRange(); change();
  };
  const autoLink=()=>{const node=editor.current,selected=window.getSelection();if(!node)return;const range=selected?.rangeCount?selected.getRangeAt(0):null;if(range&&(!range.collapsed||!node.contains(range.commonAncestorContainer)))return;const marker=document.createElement('span');if(range)range.insertNode(marker);linkifyEmailText(node);if(marker.parentNode){const caret=document.createRange();caret.setStartAfter(marker);caret.collapse(true);marker.remove();selection.current=caret.cloneRange();if(document.activeElement===node){selected?.removeAllRanges();selected?.addRange(caret);}}change();};
  const insertHtml=(html:string)=>{const node=editor.current;if(!node)return;node.focus();const range=selection.current?.cloneRange()||document.createRange();if(!node.contains(range.commonAncestorContainer)){range.selectNodeContents(node);range.collapse(false);}range.deleteContents();const fragment=range.createContextualFragment(html),last=fragment.lastChild;range.insertNode(fragment);if(last){range.setStartAfter(last);range.collapse(true);const selected=window.getSelection();selected?.removeAllRanges();selected?.addRange(range);selection.current=range.cloneRange();}autoLink();};
  const insertImages=async(files:File[])=>{try{const loaded=await onImages(files);const fragments=loaded.map(file=>{const image=document.createElement('img');image.dataset.mailCid=file.cid;image.src='data:'+file.content_type+';base64,'+file.content_base64;image.alt=file.filename;image.style.cssText='max-width:100%;height:auto;vertical-align:middle';return image.outerHTML;});insertHtml(fragments.join(''));}catch{}};
  return <div className="rich-message">
    <div className="mail-formatting" role="toolbar" aria-label="Message formatting">{[{tag:'strong',label:'Bold',Icon:Bold},{tag:'em',label:'Italic',Icon:Italic},{tag:'u',label:'Underline',Icon:Underline},{tag:'ul',label:'Bulleted list',Icon:List}].map(({tag,label,Icon}) => <button type="button" key={tag} className="icon-button" title={label} aria-label={label} onMouseDown={event=>event.preventDefault()} onClick={()=>insert(tag)}><Icon size={16}/></button>)}<button type="button" className="icon-button" title="Insert link" aria-label="Insert link" onMouseDown={event=>event.preventDefault()} onClick={()=>setLink('https://')}><Link2 size={16}/></button><button type="button" className="icon-button" title="Insert inline image" aria-label="Insert inline image" onMouseDown={event=>event.preventDefault()} onClick={()=>{remember();imageInput.current?.click();}}><ImagePlus size={16}/></button><input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple aria-label="Inline image files" hidden onChange={event=>{const files=[...(event.target.files||[])];event.target.value='';void insertImages(files);}}/></div>
    {link !== null && <div className="mail-link-editor"><input aria-label="Link URL" type="url" value={link} onChange={event=>setLink(event.target.value)}/><Button type="button" variant="secondary" disabled={!/^https?:\/\/[^\s]+$/i.test(link)} onClick={()=>{insert('a',link);setLink(null);}}>Insert</Button><button type="button" className="icon-button" aria-label="Cancel link" onClick={()=>setLink(null)}><X size={16}/></button></div>}
    <div className="mail-rich-input" ref={editor} role="textbox" aria-label="Message" aria-multiline="true" contentEditable suppressContentEditableWarning onInput={change} onKeyUp={event=>{remember();if(event.key===' '||event.key==='Enter')autoLink();}} onMouseUp={remember} onBlur={()=>{remember();autoLink();}} onPaste={event=>{event.preventDefault();remember();const images=[...event.clipboardData.files].filter(file=>file.type.startsWith('image/'));if(images.length){void insertImages(images);return;}const html=event.clipboardData.getData('text/html');insertHtml(html?safeEditorHtml(html):textEmailHtml(event.clipboardData.getData('text/plain')));}}/>
    {inlineImages.length>0&&<div className="inline-image-list" aria-label="Inline images">{inlineImages.map(file=><span key={file.cid}><ImagePlus size={14}/>{file.filename}<button type="button" className="icon-button" aria-label={'Remove inline '+file.filename} onClick={()=>{for(const image of editor.current?.querySelectorAll<HTMLImageElement>('img')||[])if(image.dataset.mailCid===file.cid)image.remove();change();}}><X size={13}/></button></span>)}</div>}
  </div>;
}

export function MailComposer({ initial = {}, onClose, onQueued }: { initial?: Row; onClose: () => void; onQueued: () => void }) {
  const { accounts, settings, act, notify } = useWorkspace();
  const mailboxes = accounts.filter(account=>account.status==='active'&&account.verified_at);
  const preferred = mailboxes.find(account=>account.id===initial.account_id) || mailboxes.find(account=>account.is_default) || mailboxes[0];
  const [data, setData] = useState<Row>({ to:'', subject:'', body_text:'', body_html:'', attachments:[], inline_images:[], include_signature:true, signature:preferred?.signature ?? settings.signature ?? '', open_tracking:true, ...initial, account_id: initial.reply_id ? initial.account_id || '' : preferred?.id || '' });
  const fallbackMailboxId = preferred?.id || '';
  useEffect(() => {
    if (!data.account_id && !data.reply_id && fallbackMailboxId) setData(current => current.account_id || current.reply_id ? current : {...current, account_id:fallbackMailboxId, signature:initial.signature ?? preferred?.signature ?? settings.signature ?? ''});
  }, [data.account_id, data.reply_id, fallbackMailboxId]);
  const [draftId, setDraftId] = useState(initial.id || '');
  const [busy, setBusy] = useState(false), [readingFiles, setReadingFiles] = useState(false), [error, setError] = useState(''), [signatureOpen, setSignatureOpen] = useState(false), [draftSaved, setDraftSaved] = useState(false);
  const field = (key: string, value: any) => { setData(current=>({...current,[key]:value})); setDraftSaved(false); };
  const payload = () => Object.fromEntries(Object.entries(data).filter(([key])=>['account_id','to','subject','body_text','body_html','attachments','inline_images','include_signature','signature','open_tracking','reply_id'].includes(key)));
  const saveDraft = async (close = false) => {
    setBusy(true);setError('');
    try { const saved = await api<Row>(draftId?`/inbox/drafts/${draftId}`:'/inbox/drafts', draftId?patch(payload()):body(payload()));setDraftId(saved.id);setDraftSaved(true);notify('Draft saved privately. Find it in Drafts.');if(close)onClose();onQueued(); }
    catch (error:any) { setError(error.message); } finally { setBusy(false); }
  };
  const attach = async (files: FileList | null) => {
    if (!files) return;setError('');setReadingFiles(true);
    try {
      const selected = [...files], existing = [...(data.attachments || []),...(data.inline_images||[])];
      if(existing.length+selected.length>10||existing.reduce((sum:number,file:Row)=>sum+Math.floor(file.content_base64.length*3/4),0)+selected.reduce((sum,file)=>sum+file.size,0)>5*1024*1024)throw new Error('Choose up to 10 attachments, totaling 5 MB or less.');
      const loaded=await Promise.all(selected.map(file=>new Promise<Row>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({filename:file.name,content_type:file.type||'application/octet-stream',content_base64:String(reader.result).split(',')[1]});reader.onerror=()=>reject(new Error('This attachment could not be read.'));reader.readAsDataURL(file);})));field('attachments',[...data.attachments,...loaded]);
    }catch(error:any){setError(error.message);}finally{setReadingFiles(false);}
  };
  const addInlineImages=async(files:File[])=>{
    setError('');setReadingFiles(true);
    try{const existing=[...data.attachments,...data.inline_images];if(existing.length+files.length>10||existing.reduce((sum:number,file:Row)=>sum+Math.floor(file.content_base64.length*3/4),0)+files.reduce((sum,file)=>sum+file.size,0)>5*1024*1024)throw new Error('Use up to 10 files including inline images, totaling 5 MB or less.');
      const loaded=await Promise.all(files.map(async file=>{if(!['image/png','image/jpeg','image/gif','image/webp'].includes(file.type))throw new Error('Choose a PNG, JPEG, GIF or WebP image.');const content_base64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Image could not be read.'));reader.readAsDataURL(file);});return {filename:file.name,content_type:file.type,content_base64,cid:crypto.randomUUID()+'@crm.inline'};}));setData(current=>({...current,inline_images:[...current.inline_images,...loaded]}));setDraftSaved(false);return loaded;
    }catch(error:any){setError(error.message);throw error;}finally{setReadingFiles(false);}
  };
  const title = data.reply_id ? 'Reply to email' : initial.forward ? 'Forward message' : 'New message';
  const sendHint = readingFiles ? 'Wait for attachments to finish loading.'
    : !mailboxes.some(account=>account.id===data.account_id) ? 'Choose an active, validated From mailbox.'
    : !data.to.trim() ? 'Enter the recipient’s email address.'
    : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.to.trim()) ? 'Enter a valid recipient email address.'
    : !data.subject.trim() ? 'Add a subject.'
    : !data.body_text.trim() ? 'Write a message before sending.' : '';
  return <Modal title={title} description="Write an email from your connected mailbox." wide onClose={()=>{if(!busy&&!readingFiles)onClose();}}><form className="mail-compose" onSubmit={async event=>{
    event.preventDefault();setBusy(true);setError('');
    try {
      const outgoing = { body_text:data.body_text, body_html:data.body_html, attachments:data.attachments, inline_images:data.inline_images, include_signature:data.include_signature, signature:data.signature, open_tracking:data.open_tracking, ...(draftId?{draft_id:draftId}:{}) };
      await act(data.reply_id?`/inbox/${data.reply_id}/reply`:'/inbox/compose',body(data.reply_id?outgoing:{...outgoing,account_id:data.account_id,to:data.to.trim(),subject:data.subject.trim()}));
      notify('Email added to Outbox. Sending progress updates automatically.');onClose();onQueued();void api('/inbox/process',body({mode:'inbox'})).then(onQueued).catch(()=>notify('Email is kept in Outbox for automatic processing.'));
    }catch(error:any){setError(error.message);}finally{setBusy(false);}
  }}><fieldset disabled={busy||readingFiles}>
    <div className="compose-envelope"><Field label="From mailbox"><select required disabled={Boolean(data.reply_id)} value={data.account_id} onChange={event=>{const mailbox=mailboxes.find(account=>account.id===event.target.value);setData(current=>({...current,account_id:event.target.value,signature:mailbox?.signature ?? settings.signature ?? ''}));setDraftSaved(false);}}><option value="" disabled>Choose a validated mailbox</option>{mailboxes.map(account=><option key={account.id} value={account.id}>{account.sender_name || account.label} &lt;{account.email}&gt;</option>)}</select></Field>
    <Field label="To email"><input type="email" required maxLength={254} readOnly={Boolean(data.reply_id)} value={data.to} onChange={event=>field('to',event.target.value)} autoComplete="email"/></Field>
    <Field label="Subject"><input required maxLength={998} readOnly={Boolean(data.reply_id)} value={data.subject} onChange={event=>field('subject',event.target.value)}/></Field></div>
    <RichMessage text={data.body_text} html={data.body_html} inlineImages={data.inline_images} onImages={addInlineImages} onChange={(text,html)=>{setData(current=>({...current,body_text:text,body_html:html,inline_images:current.inline_images.filter((file:Row)=>html.includes('cid:'+file.cid))}));setDraftSaved(false);}}/>
    <div className="mail-file-list">{data.attachments.map((file:Row,index:number)=><div key={index}><Paperclip size={15}/><span>{file.filename}</span><small>{fileSize(Math.floor(file.content_base64.length*3/4))}</small><button type="button" className="icon-button" aria-label={`Remove ${file.filename}`} onClick={()=>field('attachments',data.attachments.filter((_:Row,i:number)=>i!==index))}><X size={15}/></button></div>)}</div>
    <div className="compose-options"><label className="mail-attach"><Paperclip size={16}/>Attach files<input type="file" multiple aria-label="Attach files" onChange={event=>{void attach(event.target.files);event.target.value='';}}/></label><label className="inline-check"><input type="checkbox" checked={data.include_signature} onChange={event=>field('include_signature',event.target.checked)}/><PenLine size={15}/>Signature</label><button type="button" className="text-button" onClick={()=>setSignatureOpen(!signatureOpen)}>{signatureOpen?'Hide signature':'Edit signature'}</button><label className="inline-check" title="Records image loads; privacy tools may hide or trigger opens."><input type="checkbox" checked={data.open_tracking} onChange={event=>field('open_tracking',event.target.checked)}/><Eye size={15}/>Track opens</label></div>
    {signatureOpen&&<Field label="Email signature"><textarea rows={3} maxLength={10000} value={data.signature} onChange={event=>field('signature',event.target.value)}/></Field>}
    {data.include_signature&&data.signature&&!signatureOpen&&<div className="compose-signature">{data.signature}</div>}
    <p className="mail-tracking-help">{data.open_tracking?'Opens are estimates, not proof of reading. Images blocked by the recipient cannot record an open.':'Open tracking is off for this email.'} Attachments and inline images: up to 10 files, 5 MB total.</p>
    </fieldset><FormError error={error}/>{sendHint&&<p id="compose-send-hint" className="mail-tracking-help" role="status">{sendHint}</p>}<div className="compose-footer"><Button type="submit" busy={busy} disabled={Boolean(sendHint)} aria-describedby={sendHint?"compose-send-hint":undefined}><Send size={15}/>Send message</Button><Button type="button" variant="secondary" disabled={busy||readingFiles} onClick={()=>void saveDraft(true)}><Save size={15}/>{draftSaved?'Saved':'Save draft & close'}</Button>{draftId&&<button type="button" className="icon-button" aria-label="Discard draft" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await api(`/inbox/drafts/${draftId}`,patch({discard:true}));onQueued();onClose();}catch(error:any){setError(error.message);}finally{setBusy(false);}}}><Trash2 size={16}/></button>}<Button type="button" variant="ghost" disabled={busy||readingFiles} onClick={onClose}>Cancel</Button></div></form></Modal>;
}
