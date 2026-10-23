'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowDown, CheckCircle2, ChevronDown, Mail, MessageCircle, PenSquare, RefreshCw, Search, Send, ShieldCheck, Reply, Forward, Paperclip, Eye, FileText, Maximize2, ShieldAlert, Inbox as InboxIcon } from 'lucide-react';
import { api, body, date, initials, list, patch, useResource, type Row } from '../api';
import { useWorkspace } from '../context';
import { Badge, Button, Empty, Field, FormError, HtmlPreview, Modal, PageHeader, Panel, Resource, Status } from '../ui';
import { MailComposer, fileSize } from '../mail-compose';
import { escapeEmailText } from '../email-editor';

const validEmail = (value: string) => /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value) && value.length <= 254;
const participant = (message: Row) => String(message.direction === 'outbound' ? message.to_email || '' : message.from_email || '').trim().toLowerCase();
const personName = (message: Row) => (message.direction === 'outbound' ? message.to_name : message.from_name) || participant(message);
const messageStatus = (message: Row) => message.classification && !['unmatched', 'outbound'].includes(message.classification) ? message.classification : message.direction === 'outbound' ? 'outgoing' : 'incoming';
const liveInbox = { pollIntervalMs: 10000, refreshOnFocus: true, keepPreviousData: true };
const liveMailboxes = { pollIntervalMs: 30000, refreshOnFocus: true, keepPreviousData: true };
const sendingStates: Record<string, { label: string; tone: string }> = {
  accepted: { label: 'Sent to mail server', tone: 'green' },
  sending: { label: 'Sending', tone: 'blue' }, submitting: { label: 'Sending', tone: 'blue' }, leased: { label: 'Processing', tone: 'blue' },
  reserved: { label: 'Preparing to send', tone: 'blue' }, queued: { label: 'Queued', tone: 'blue' },
  held: { label: 'Needs review', tone: 'amber' }, unknown: { label: 'Needs review', tone: 'amber' },
  failed: { label: 'Sending failed', tone: 'red' }, cancelled: { label: 'Cancelled', tone: 'amber' },
};
function SendStatus({ value }: { value: string }) {
  const state = sendingStates[value];
  return state ? <Badge tone={state.tone}>{state.label}</Badge> : <Status value={value} />;
}
function MessageStatus({ message, interactive = true }: { message: Row; interactive?: boolean }) {
  const [showOpens, setShowOpens] = useState(false);
  const tracked = message.direction === 'outbound' && Boolean(message.open_tracking);
  const label = message.open_count ? 'Open recorded' : 'No open recorded';
  const recordedTime = (value: string) => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) : 'Not recorded';
  return <><span className="mail-status-group">{message.direction === 'outbound' && message.send_status ? <SendStatus value={message.send_status} /> : <Status value={messageStatus(message)} />}{tracked && (interactive ? <button type="button" className={`mail-open-status ${message.open_count ? 'recorded' : ''}`} onClick={() => setShowOpens(true)} aria-haspopup="dialog"><Eye size={13}/>{label}</button> : <span className={`mail-open-status ${message.open_count ? 'recorded' : ''}`}><Eye size={13}/>{label}</span>)}</span>{showOpens && <Modal title="Email open activity" onClose={() => setShowOpens(false)}><div className="open-tracking-summary"><p className="panel-note">To {message.to_name || message.to_email}</p><dl><div><dt>Recorded opens</dt><dd>{Number(message.open_count || 0)}</dd></div><div><dt>First recorded open</dt><dd>{recordedTime(message.first_opened_at)}</dd></div><div><dt>Last recorded open</dt><dd>{recordedTime(message.last_opened_at)}</dd></div><div><dt>Time spent reading</dt><dd>Unavailable</dd></div></dl><p className="panel-note">These are tracking-image loads, not confirmed reads. Image blocking, privacy proxies and automated scanners can hide or add opens. Email tracking cannot reliably measure reading duration.</p></div><div className="form-footer"><Button variant="secondary" onClick={() => setShowOpens(false)}>Close</Button></div></Modal>}</>;
}
function SenderIdentity({ name, email }: { name: string; email: string }) {
  return <details className="mail-person"><summary><span className="avatar avatar-small">{initials(name || email)}</span><span><strong>{name || email}</strong><small>{name ? email : 'Sender details'}</small></span><ChevronDown size={12}/></summary><div className="mail-person-card"><strong>{name || email}</strong><span>{email}</span></div></details>;
}
function processInbox(mode: 'inbox' | 'sync', refresh: () => void, notify: (message: string, error?: boolean) => void) {
  void api('/inbox/process', body({ mode })).then(refresh).catch(() => {
    notify(mode === 'sync' ? 'Mailbox check remains queued for the next automatic sync.' : 'Your message is kept in Outbox. Automatic processing will try it when eligible.');
    refresh();
  });
}

export function InboxPage({ messageId = '' }: { messageId?: string }) {
  const { revision, accounts, can, act, notify, refresh } = useWorkspace();
  const [classification, setClassification] = useState('');
  const [account, setAccount] = useState('');
  const [search, setSearch] = useState('');
  const selected = messageId;
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState<Row>({});
  const router = useRouter(); const params = useSearchParams();
  const folder = ['inbox','sent','spam','drafts'].includes(params.get('folder') || '') ? params.get('folder')! : 'inbox';
  const showDrafts = folder === 'drafts';
  const query = new URLSearchParams({ folder: showDrafts ? 'inbox' : folder, ...(classification ? { classification } : {}), ...(account ? { account_id: account } : {}) });
  const resource = useResource(`/inbox?${query}`, revision, liveInbox);
  const outbox = useResource('/inbox/outbox', revision, liveInbox);
  const drafts = useResource('/inbox/drafts', revision, liveInbox);
  const mailboxResource = useResource('/accounts', revision, liveMailboxes);
  const currentAccounts = mailboxResource.data ? list(mailboxResource.data) : accounts;
  const rows = list(resource.data).filter(m => `${m.from_email} ${m.subject} ${m.latest_subject || ''} ${m.to_email}`.toLowerCase().includes(search.toLowerCase()));
  const pending = list(outbox.data).filter(job => (!account || job.account_id === account) && `${job.recipient} ${job.subject}`.toLowerCase().includes(search.toLowerCase()));

  return <div className={`inbox-workspace ${selected ? 'has-conversation' : ''}`}>
    <PageHeader eyebrow="THE CONVERSATION CONTINUES" title="Inbox" description="Read, reply, and start a new conversation." actions={<>
      {can('system:write') && <Button variant="secondary" busy={busy} disabled={!accounts.length} onClick={async () => {
        setBusy(true);
        try {
          const targets = account ? accounts.filter(a => a.id === account) : accounts;
          for (const a of targets) await act(`/accounts/${a.id}/sync`, body({}));
          if (targets.length) { resource.reload(); notify('Mailbox check requested. New messages will appear automatically after syncing.'); if (can('inbox:write')) processInbox('sync', refresh, notify); }
        } catch {} finally { setBusy(false); }
      }}><RefreshCw size={16} />Sync inbox</Button>}
      {can('inbox:write') && <Button onClick={() => { setDraft({account_id:account});setComposing(true); }}><PenSquare size={16} />New message</Button>}
    </>} />
    <div className="inbox-sync-note"><span className="tiny-dot" /><span>Last sync: {date(currentAccounts.filter(a => !account || a.id === account).map(a => a.last_successful_sync_at).filter(Boolean).sort().at(-1), true)}</span><span>Refreshes automatically every 10 seconds.</span><span>Embedded images display safely; external images load only when requested.</span></div>
    {(resource.refreshError || outbox.error || outbox.refreshError || mailboxResource.error || mailboxResource.refreshError) && <p className="panel-note" role="status">Live updates are temporarily unavailable. Retrying automatically; your messages and drafts are kept.</p>}
    <Panel className="inbox-panel">
      <div className="inbox-toolbar">
        <div className="search-field"><Search size={17} /><input aria-label="Search conversations" placeholder="Search conversations…" value={search} onChange={e => setSearch(e.target.value)} /></div>
        <div className="filters">
          <select aria-label="Conversation classification" value={classification} onChange={e => setClassification(e.target.value)}><option value="">All conversations</option><option value="outbound">Outgoing</option><option value="human_reply">Human replies</option><option value="automatic">Automatic replies</option><option value="delivery_failure">Delivery failures</option><option value="unmatched">New messages</option><option value="uncertain">Needs review</option></select>
          <select aria-label="Inbox mailbox" value={account} onChange={e => setAccount(e.target.value)}><option value="">All mailboxes</option>{accounts.map(a => <option value={a.id} key={a.id}>{a.label} · {a.email}</option>)}</select>
        </div>
      </div>
      <div className="inbox-layout">
        <aside className="inbox-sidebar" aria-label="Mailbox conversations">
          <section aria-label="Outbox" className="inbox-sidebar-header"><details className="inbox-outbox"><summary><div><strong>Outbox</strong><p>Sending progress and messages needing attention</p></div><Badge>{pending.length}</Badge><ChevronDown size={17} /></summary><div className="outbox-items">{pending.length ? pending.map(job => <div className="conversation-item" key={job.id}><div className="conversation-top"><strong>{job.recipient}</strong><time>{date(job.updated_at || job.created_at, true)}</time></div><h3>{job.subject || '(No subject)'}</h3>{job.last_error && <p>{job.last_error}</p>}<SendStatus value={job.status} />{['held', 'failed'].includes(job.status) && can('system:write') && <p><Link href="/health">Review in System health</Link></p>}</div>) : <p className="panel-note">No queued messages.</p>}</div></details></section>
          <div className="conversation-list-label inbox-folder-tabs" aria-label="Mail folders">{[{key:'inbox',label:'Inbox',icon:InboxIcon},{key:'sent',label:'Sent',icon:Send},{key:'spam',label:'Spam',icon:ShieldAlert},{key:'drafts',label:'Drafts',icon:FileText}].map(({key,label,icon:Icon})=><button type="button" key={key} className={folder===key?'selected':''} aria-pressed={folder===key} onClick={()=>router.push('/inbox?folder='+key,{scroll:false})}><Icon size={13}/>{label}{key !== 'drafts' && Number(resource.data?.unread_counts?.[key]) > 0 && <span aria-label={resource.data.unread_counts[key] + ' unread conversations'}>{resource.data.unread_counts[key]}</span>}</button>)}</div>
          {folder === 'spam' && <p className="spam-view-note">CRM spam only. Provider folders are unchanged.</p>}
          <div className="conversation-list" role="region" aria-label="Conversation list" tabIndex={0}>{showDrafts?<Resource {...drafts} retry={drafts.reload}>{list(drafts.data).length?list(drafts.data).map(item=><button type="button" key={item.id} className="conversation-item mail-draft-item" onClick={async()=>{try{setDraft(await api<Row>(`/inbox/drafts/${item.id}`));setComposing(true);}catch(error:any){notify(error.message,true);}}}><strong>{item.to || 'No recipient'}</strong><h3>{item.subject}</h3><p>Draft · {date(item.updated_at,true)}</p></button>):<Empty title="No saved drafts" description="Save a draft from the email composer and return to it here."/>}</Resource>:<Resource {...resource} retry={resource.reload}>{rows.length ? rows.map(m => {
            const active = selected === m.id || m.message_ids?.includes(selected);
            return <Link className={`conversation-item ${active ? 'active' : ''} ${m.unread_count ? 'is-unread' : 'is-read'}`} key={m.thread_id || m.id} href={`/inbox/${m.id}?folder=${folder}`} scroll={false} aria-current={active ? 'page' : undefined}>
              <div className="conversation-top"><span className="avatar contact-avatar">{initials(personName(m) || 'Mail')}</span><strong title={participant(m)}>{personName(m) || 'Message'}</strong><time>{date(m.accepted_at || m.received_at || m.created_at, true)}</time></div>
              <div className="conversation-subject">{m.unread_count > 0 && <span className="unread-indicator" aria-label="Unread message" title="Unread" />}<h3>{m.subject || '(No subject)'}</h3>{m.message_count > 1 && <span className="conversation-count" aria-label={`${m.message_count} messages in conversation`}>{m.message_count}</span>}</div><div className="conversation-preview"><p>{m.preview || 'Open to read this conversation.'}</p>{(m.send_status || !['unmatched', 'outbound'].includes(m.classification)) && <MessageStatus message={m} interactive={false} />}</div>
            </Link>;
          }) : <Empty title={folder === 'sent' ? 'No sent emails yet' : folder === 'spam' ? 'No spam conversations' : 'A little quiet, for now.'} description={folder === 'sent' ? 'Emails accepted by the mail server appear here. Queued emails stay in Outbox.' : folder === 'spam' ? 'Move unwanted conversations to Spam from the conversation header. This view is managed inside the CRM.' : 'Synced incoming messages and their conversations will appear here.'} />}</Resource>}</div>
        </aside>
        <section className="conversation-detail">{selected ? <Conversation key={selected} id={selected} accounts={currentAccounts} onRead={resource.reload} folder={folder} /> : <div className="inbox-welcome">
          <div className="inbox-welcome-art"><MessageCircle size={36} /><Mail size={23} /></div><h2>Good conversations live here.</h2><p>Select a message to read and reply, or choose New message to start a conversation.</p><div><ShieldCheck size={16} />Human replies stop automated follow-ups.</div>
        </div>}</section>
      </div>
    </Panel>
    {composing && can('inbox:write') && <MailComposer initial={draft} onClose={() => setComposing(false)} onQueued={refresh} />}
  </div>;
}

function Conversation({ id, accounts, onRead, folder }: { id: string; accounts: Row[]; onRead: () => void; folder: string }) {
  const { revision, users, settings, can, act, refresh, notify } = useWorkspace();
  const router = useRouter();
  const [moving, setMoving] = useState(false);
  const [showRemoteImages, setShowRemoteImages] = useState(false);
  const resource = useResource(`/inbox/${id}${showRemoteImages?'?remote_images=true':''}`, revision, liveInbox);
  const data = resource.data || {};
  const message = data.message || data;
  const thread = data.thread?.length ? data.thread : [message];
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [queued, setQueued] = useState('');
  const [composer, setComposer] = useState<Row|null>(null);
  const [replyTo, setReplyTo] = useState('');
  const [trackOpens, setTrackOpens] = useState(true);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const previousLast = useRef('');
  const [newMessages, setNewMessages] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const acknowledged = useRef(new Set<string>());
  const markingRead = useRef(false);
  useEffect(() => {
    if (!resource.data || document.hidden || markingRead.current) return;
    const ids = (resource.data.thread || []).filter((item: Row) => item.direction === 'inbound' && !item.is_read && !acknowledged.current.has(item.id)).map((item: Row) => item.id).slice(0, 1000);
    if (!ids.length) return;
    markingRead.current = true;
    void api<Row>('/inbox/' + id + '/read', body({ message_ids: ids })).then(result => {
      for (const messageId of result.read_ids) acknowledged.current.add(messageId);
      onRead();
    }).catch(() => { /* A future refresh retries; failed writes never clear the highlight. */ }).finally(() => { markingRead.current = false; });
  }, [resource.data, id, onRead]);
  const toggleMessage = (messageId: string) => { followLatest.current = false; setCollapsed(previous => { const next = new Set(previous); if (next.has(messageId)) next.delete(messageId); else next.add(messageId); return next; }); };
  const lastId = thread.at(-1)?.id || '';
  const scrollToLatest = () => { const node = scrollRef.current; if (node) node.scrollTop = node.scrollHeight; followLatest.current = true; setNewMessages(false); };
  useEffect(() => {
    if (!lastId || previousLast.current === lastId) return;
    const first = !previousLast.current; previousLast.current = lastId;
    if (first || followLatest.current) scrollToLatest(); else setNewMessages(true);
  }, [lastId]);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => { if (followLatest.current) node.scrollTop = node.scrollHeight; });
    observer.observe(node);
    for (const article of node.querySelectorAll('.thread-message')) observer.observe(article);
    return () => observer.disconnect();
  }, [Boolean(resource.data), lastId]);
  const replySource = thread.find((item: Row) => item.id === (replyTo || data.reply_message_id)) || thread.at(-1) || message;
  const replyRecipient = participant(replySource);
  const mailbox = accounts.find(a => a.id === message.account_id);

  return <Resource {...resource} retry={resource.reload}>
    {resource.refreshError && <p className="panel-note" role="status">This conversation could not refresh. Retrying automatically; your reply draft is kept.</p>}
    <div className="conversation-heading">
      <Link href={'/inbox?folder=' + folder} className="text-link conversation-back"><ArrowLeft size={17} />All conversations</Link>
      <div className="conversation-title"><h2>{data.conversation_subject || message.subject || '(No subject)'}</h2><MessageStatus message={replySource} /></div>
      <p className="conversation-with">With <strong>{personName(replySource) || 'No reply address available'}</strong> {personName(replySource)!==replyRecipient&&<span>&lt;{replyRecipient}&gt;</span>}</p>
      <details className="conversation-options"><summary>Details <ChevronDown size={14} /></summary><p>Mailbox: {mailbox?.email || (message.direction === 'outbound' ? message.from_email : message.to_email)}</p>
      {can('inbox:write') && <Button variant="ghost" className="spam-folder-action" busy={moving} title="Organize this conversation inside the CRM; provider folders are unchanged." onClick={async()=>{setMoving(true);try{const target=data.is_spam?'inbox':'spam';await act('/inbox/'+id+'/folder',body({folder:target}),target==='spam'?'Conversation moved to Spam in this CRM.':'Conversation removed from Spam.');const destination=target==='inbox'&&!thread.some((item:Row)=>item.direction==='inbound')?'sent':target;router.push('/inbox?folder='+destination,{scroll:false});}catch{}finally{setMoving(false);}}}>{data.is_spam?<InboxIcon size={14}/>:<ShieldAlert size={14}/>} {data.is_spam?'Move to inbox':'Move to spam'}</Button>}
      {can('inbox:write') && <div className="conversation-management"><Field label="Assigned teammate"><select value={message.assigned_to || ''} onChange={e => { act(`/inbox/${id}`, patch({ assigned_to: e.target.value || null }), 'Conversation assignment updated.').catch(() => {}); }}><option value="">Unassigned</option>{users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field></div>}</details>
    </div>
    {!showRemoteImages && thread.some((item:Row)=>item.has_remote_images) && <div className="remote-image-notice"><span>External images are hidden. Loading them may notify the sender.</span><button type="button" onClick={()=>setShowRemoteImages(true)}>Show external images</button></div>}
    <div className="thread-messages" ref={scrollRef} role="region" aria-label="Conversation messages" tabIndex={0} onScroll={() => { const node = scrollRef.current; if (node) { followLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; if (followLatest.current) setNewMessages(false); } }}>{thread.length > 1 && <div className="thread-controls"><span>{thread.length} messages</span><button type="button" onClick={() => { followLatest.current = false; setCollapsed(new Set(thread.slice(0, -1).map((item: Row) => item.id))); }}>Collapse older messages</button><button type="button" onClick={() => { followLatest.current = false; setCollapsed(new Set()); }}>Expand all</button></div>}{thread.map((m: Row, i: number) => <article className={`thread-message ${m.direction === 'outbound' ? 'outbound' : ''} ${collapsed.has(m.id) ? 'is-collapsed' : ''}`} key={m.id || i}>
      <div className="thread-message-heading"><button type="button" className="icon-button message-collapse" aria-label={collapsed.has(m.id) ? 'Expand message' : 'Collapse message'} aria-expanded={!collapsed.has(m.id)} aria-controls={'message-body-' + m.id} onClick={() => toggleMessage(m.id)}><ChevronDown size={16}/></button><SenderIdentity name={m.from_name||''} email={m.from_email||''}/><time>{date(m.accepted_at || m.received_at || m.created_at, true)}</time>{can('inbox:write')&&<><button type="button" className="icon-button" aria-label={`Reply to ${m.from_name||m.from_email}`} title="Reply" onClick={()=>{setReplyTo(m.id);replyRef.current?.focus();}}><Reply size={16}/></button><button type="button" className="icon-button" aria-label={`Forward ${m.subject}`} title="Forward" onClick={async()=>{try{const attachments=await Promise.all([...(m.attachments||[]),...(m.inline_images||[])].filter((file:Row)=>!file.unavailable).map(async(file:Row)=>{const response=await fetch(`/api/inbox/${m.id}/attachments/${file.id}`,{credentials:'same-origin'});if(!response.ok)throw new Error('An attachment could not be included.');const blob=await response.blob();const content_base64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(blob);});return {filename:file.filename,content_type:file.content_type,content_base64,...(file.cid?{cid:file.cid}:{})};}));let forwardedHtml=m.body_html||'';for(const file of m.inline_images||[])if(file.cid)forwardedHtml=forwardedHtml.replaceAll('/api/inbox/'+m.id+'/inline/'+file.id,'cid:'+file.cid);setComposer({forward:true,body_html:forwardedHtml?'<p>Forwarded message from '+escapeEmailText(m.from_name||m.from_email)+'</p>'+forwardedHtml:'',inline_images:attachments.filter((file:Row)=>file.cid),account_id:m.account_id,to:'',subject:/^fwd:/i.test(m.subject)?m.subject:`Fwd: ${m.subject}`,body_text:`\n\n---------- Forwarded message ----------\nFrom: ${m.from_name||m.from_email} <${m.from_email}>\nDate: ${date(m.received_at,true)}\nSubject: ${m.subject}\nTo: ${m.to_email}\n\n${m.body_text}`,attachments:attachments.filter((file:Row)=>!file.cid)});}catch(error:any){notify(error.message,true);}}}><Forward size={16}/></button></>}</div>
      {collapsed.has(m.id) ? <button type="button" className="collapsed-message-preview" onClick={() => toggleMessage(m.id)}>{m.body_text || 'Expand to read this email'}</button> : <div id={'message-body-' + m.id}>
      <div className="message-delivery-line"><span>To {m.to_name||m.to_email}</span>{m.direction==='outbound'&&<MessageStatus message={m}/>}</div>
      {m.campaign_id && data.contact && m.contact_id === data.contact.id && String(data.contact.email || '').trim().toLowerCase() === participant(m) && <ReviewReply message={m} />}
      <HtmlPreview html={m.body_html || m.html} text={m.body_text || m.text} fullHeight allowRemoteImages={showRemoteImages} />
      {m.inline_images?.some((file:Row)=>file.unavailable)&&<p className="panel-note">An embedded image exceeds storage limits. Open the original email in webmail.</p>}
      {m.attachments?.length>0&&<div className="message-attachments">{m.attachments.map((file:Row)=>file.unavailable?<span key={file.id}><Paperclip size={14}/>{file.filename} · Open in webmail</span>:<a key={file.id} href={`/api/inbox/${m.id}/attachments/${file.id}`} download><Paperclip size={14}/><strong>{file.filename}</strong><small>{fileSize(file.size)}</small></a>)}</div>}
    </div>}
    </article>)}</div>
    {newMessages && <button className="new-messages-button" onClick={scrollToLatest}><ArrowDown size={15} />New messages: jump to latest</button>}
    {can('inbox:write') && <form className="reply-composer" aria-label={`Reply to ${replyRecipient}`} onSubmit={async e => {
      e.preventDefault();
      if (!message.id || !validEmail(replyRecipient)) return;
      setBusy(true); setError(''); setQueued('');
      try {
        await act(`/inbox/${replySource.id}/reply`, body({ body_text: reply, include_signature:true, open_tracking:trackOpens }));
        setQueued('Reply added to Outbox. Sending status updates automatically.');
        setReply('');
        processInbox('inbox', refresh, notify);
      } catch (err: any) { setError(err.message); } finally { setBusy(false); }
    }}>
      <textarea ref={replyRef} aria-label="Reply message" rows={2} required maxLength={100000} disabled={busy || !validEmail(replyRecipient)} value={reply} onChange={e => setReply(e.target.value)} placeholder={`Reply to ${personName(replySource) || replyRecipient}…`} />
      <div className="reply-footer"><button type="button" className="icon-button" aria-label="Expand reply with formatting and attachments" title="Formatting, attachments & signature" onClick={()=>setComposer({account_id:replySource.account_id,to:replyRecipient,subject:/^re:/i.test(replySource.subject)?replySource.subject:`Re: ${replySource.subject}`,reply_id:replySource.id,body_text:reply,signature:settings.signature||'',open_tracking:trackOpens})}><Paperclip size={16}/><Maximize2 size={13}/></button><button type="button" className={`icon-button ${trackOpens?'tracking-on':''}`} aria-label="Track opens for this reply" aria-pressed={trackOpens} title={trackOpens?'Open tracking on (estimated)':'Open tracking off'} onClick={()=>setTrackOpens(!trackOpens)}><Eye size={16}/></button><Button type="submit" busy={busy} disabled={!message.id || !validEmail(replyRecipient) || !reply.trim()}><Send size={15} />Send reply</Button></div>
      {!validEmail(replyRecipient) && <FormError error="This message has no valid reply address. Use New message to write to an email address." />}
      {queued && <div className="inbox-queue-confirmation" role="status"><CheckCircle2 size={16} /><span>{queued}</span></div>}
      <FormError error={error} />
    </form>}
    {composer&&<MailComposer initial={composer} onClose={()=>setComposer(null)} onQueued={()=>{if(composer.reply_id)setReply(current=>current===composer.body_text?'':current);refresh();}}/>}
  </Resource>;
}

function ReviewReply({ message }: { message: Row }) {
  const { can, act, notify } = useWorkspace(); const [action, setAction] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  if (!message.contact_id || message.direction !== 'inbound' || !['automatic', 'uncertain', 'delivery_failure'].includes(message.classification)) return null;
  if (message.reviewed_at) return <div className="inbox-review"><ShieldCheck size={17} /><div><strong>Reviewed · {message.review_action === 'resume' ? 'Resume approved; current safeguards still apply' : 'Outreach stopped'}</strong><p>{date(message.reviewed_at, true)}</p></div></div>;
  return <><div className="inbox-review"><ShieldCheck size={19} /><div><strong>This reply paused automated follow-ups for review.</strong><p>Read the message and check its meaning before deciding the next step.</p>{can('inbox:write') && <div className="review-actions"><Button variant="secondary" onClick={() => { setAction('resume'); setError(''); }}>Resume eligible follow-ups</Button><Button variant="ghost" onClick={() => { setAction('stop'); setError(''); }}>Stop outreach</Button></div>}</div></div>{action && <Modal title={action === 'resume' ? 'Resume after reviewing this reply?' : 'Stop automated outreach?'} description={action === 'resume' ? 'Resume only when the message does not require a human response or an opt-out. Consent, suppression, and any other unresolved reply can still block sending.' : 'Stop pending automated follow-ups for this contact across the agency.'} onClose={() => setAction('')}><form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { const result = await act<Row>(`/inbox/${message.id}/review`, body({ action })); notify(result.reason ? `Review recorded. ${result.reason}` : result.resumed ? 'Reply reviewed. Eligible follow-ups resumed.' : 'Reply reviewed and follow-up decision recorded.'); setAction(''); } catch (err: any) { setError(err.message); } finally { setBusy(false); } }}><label className="check-field"><input type="checkbox" required /><span><strong>I reviewed the message and verified this decision.</strong><small>{action === 'resume' ? 'This may make pending automated messages eligible again on their original mailbox.' : 'A future campaign must still respect this contact’s preferences.'}</small></span></label><FormError error={error} /><div className="form-footer"><Button variant="secondary" type="button" onClick={() => setAction('')}>Cancel</Button><Button busy={busy} type="submit">{action === 'resume' ? 'Confirm review & resume' : 'Confirm stop'}</Button></div></form></Modal>}</>;
}
