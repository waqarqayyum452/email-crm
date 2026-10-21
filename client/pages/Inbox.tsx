'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, Mail, MessageCircle, PenSquare, RefreshCw, Search, Send, ShieldCheck } from 'lucide-react';
import { api, body, date, initials, list, patch, useResource, type Row } from '../api';
import { useWorkspace } from '../context';
import { Badge, Button, Empty, Field, FormError, HtmlPreview, Modal, PageHeader, Panel, Resource, Status } from '../ui';

const validEmail = (value: string) => /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value) && value.length <= 254;
const readyMailbox = (account: Row) => account.status === 'active' && Boolean(account.verified_at);
const participant = (message: Row) => String(message.direction === 'outbound' ? message.to_email || '' : message.from_email || '').trim().toLowerCase();
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
function MessageStatus({ message }: { message: Row }) {
  return message.direction === 'outbound' && message.send_status ? <SendStatus value={message.send_status} /> : <Status value={messageStatus(message)} />;
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
  const query = new URLSearchParams({ ...(classification ? { classification } : {}), ...(account ? { account_id: account } : {}) });
  const resource = useResource(`/inbox?${query}`, revision, liveInbox);
  const outbox = useResource('/inbox/outbox', revision, liveInbox);
  const mailboxResource = useResource('/accounts', revision, liveMailboxes);
  const currentAccounts = mailboxResource.data ? list(mailboxResource.data) : accounts;
  const rows = list(resource.data).filter(m => `${m.from_email} ${m.subject} ${m.to_email}`.toLowerCase().includes(search.toLowerCase()));
  const pending = list(outbox.data).filter(job => (!account || job.account_id === account) && `${job.recipient} ${job.subject}`.toLowerCase().includes(search.toLowerCase()));

  return <>
    <PageHeader eyebrow="THE CONVERSATION CONTINUES" title="Inbox" description="Read, reply, and start a new conversation." actions={<>
      {can('system:write') && <Button variant="secondary" busy={busy} disabled={!accounts.length} onClick={async () => {
        setBusy(true);
        try {
          const targets = account ? accounts.filter(a => a.id === account) : accounts;
          for (const a of targets) await act(`/accounts/${a.id}/sync`, body({}));
          if (targets.length) { resource.reload(); notify('Mailbox check requested. New messages will appear automatically after syncing.'); if (can('inbox:write')) processInbox('sync', refresh, notify); }
        } catch {} finally { setBusy(false); }
      }}><RefreshCw size={16} />Sync inbox</Button>}
      {can('inbox:write') && <Button onClick={() => setComposing(true)}><PenSquare size={16} />New message</Button>}
    </>} />
    <div className="inbox-sync-note"><span className="tiny-dot" /><span>Last sync: {date(currentAccounts.filter(a => !account || a.id === account).map(a => a.last_successful_sync_at).filter(Boolean).sort().at(-1), true)}</span><span>Refreshes automatically every 10 seconds.</span><span>Remote images are blocked in message previews.</span></div>
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
        <aside className="conversation-list">{pending.length > 0 && (!classification || classification === 'outbound') && <section aria-label="Outbox"><details className="inbox-outbox"><summary><div><strong>Outbox</strong><p>Sending progress and messages needing attention</p></div><Badge>{pending.length}</Badge><ChevronDown size={17} /></summary><div className="outbox-items">{pending.map(job => <div className="conversation-item" key={job.id}><div className="conversation-top"><strong>{job.recipient}</strong><time>{date(job.updated_at || job.created_at, true)}</time></div><h3>{job.subject || '(No subject)'}</h3>{job.last_error && <p>{job.last_error}</p>}<SendStatus value={job.status} />{['held', 'failed'].includes(job.status) && can('system:write') && <p><Link href="/health">Review in System health</Link></p>}</div>)}</div></details></section>}<Resource {...resource} retry={resource.reload}>{rows.length ? rows.map(m => <Link className={`conversation-item ${selected === m.id ? 'active' : ''}`} key={m.id} href={`/inbox/${m.id}`} scroll={false} aria-current={selected === m.id ? 'page' : undefined}>
          <div className="conversation-top"><span className="avatar contact-avatar">{initials(participant(m) || 'Mail')}</span><strong>{m.direction === 'outbound' ? m.to_email : m.from_name || m.from_email || 'Message'}</strong><time>{date(m.accepted_at || m.received_at || m.created_at, true)}</time></div>
          <h3>{m.subject || '(No subject)'}</h3><p>{m.body_text?.slice(0, 100) || 'Open to read this message.'}</p><MessageStatus message={m} />
        </Link>) : <Empty title="A little quiet, for now." description="Synced messages and your conversations will appear here." />}</Resource></aside>
        <section className="conversation-detail">{selected ? <Conversation key={selected} id={selected} accounts={currentAccounts} /> : <div className="inbox-welcome">
          <div className="inbox-welcome-art"><MessageCircle size={36} /><Mail size={23} /></div><h2>Good conversations live here.</h2><p>Select a message to read and reply, or choose New message to start a conversation.</p><div><ShieldCheck size={16} />Human replies stop automated follow-ups.</div>
        </div>}</section>
      </div>
    </Panel>
    {composing && can('inbox:write') && <NewMessage selectedAccount={account} onClose={() => setComposing(false)} />}
  </>;
}

function NewMessage({ selectedAccount, onClose }: { selectedAccount: string; onClose: () => void }) {
  const { accounts, can, act, refresh, notify } = useWorkspace();
  const mailboxes = accounts.filter(readyMailbox);
  const preferredAccount = mailboxes.find(a => a.id === selectedAccount) || mailboxes.find(a => Number(a.is_default) === 1) || mailboxes[0];
  const [account, setAccount] = useState<string>(preferredAccount?.id || '');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selectedMailbox = mailboxes.find(a => a.id === account);

  useEffect(() => {
    if (!mailboxes.some(a => a.id === account)) setAccount(preferredAccount?.id || '');
  }, [account, preferredAccount?.id, accounts]);

  return <Modal title="New message" description="Choose your mailbox and write directly to an email address." onClose={() => { if (!busy) onClose(); }} wide>
    {!mailboxes.length ? <Empty title="Connect a sending mailbox" description={can('settings:write') ? 'Add a mailbox, validate its connection, and set its status to Active before writing a message.' : 'Ask your workspace owner to connect, validate, and activate a sending mailbox.'} action={<Link className="button secondary" href="/settings/accounts" onClick={onClose}>Open mailbox settings</Link>} /> : <form className="inbox-new-message" onSubmit={async e => {
      e.preventDefault();
      if (!selectedMailbox || !validEmail(to.trim())) return;
      setBusy(true); setError('');
      try {
        await act('/inbox/compose', body({ account_id: account, to: to.trim(), subject: subject.trim(), body_text: message }), `Message added to Outbox for ${to.trim()}. Its sending status updates automatically.`);
        onClose();
        processInbox('inbox', refresh, notify);
      } catch (err: any) { setError(err.message); } finally { setBusy(false); }
    }}>
      <Field label="From mailbox"><select required value={account} disabled={busy} onChange={e => setAccount(e.target.value)}>{mailboxes.map(a => <option key={a.id} value={a.id}>{a.label} · {a.email}</option>)}</select></Field>
      <Field label="To email"><input required type="email" maxLength={254} value={to} disabled={busy} onChange={e => setTo(e.target.value)} placeholder="recipient@example.com" autoComplete="email" /></Field>
      <Field label="Subject"><input required maxLength={998} value={subject} disabled={busy} onChange={e => setSubject(e.target.value)} placeholder="Subject" /></Field>
      <Field label="Message"><textarea required rows={9} maxLength={100000} value={message} disabled={busy} onChange={e => setMessage(e.target.value)} placeholder="Write your message…" /></Field>
      <FormError error={error} />
      <div className="form-footer"><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" busy={busy} disabled={!selectedMailbox || !validEmail(to.trim()) || !subject.trim() || !message.trim()}><Send size={15} />Queue message</Button></div>
    </form>}
  </Modal>;
}

function Conversation({ id, accounts }: { id: string; accounts: Row[] }) {
  const { revision, users, can, act, refresh, notify } = useWorkspace();
  const resource = useResource(`/inbox/${id}`, revision, liveInbox);
  const data = resource.data || {};
  const message = data.message || data;
  const thread = data.thread?.length ? data.thread : [message];
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [queued, setQueued] = useState('');
  const replyRecipient = participant(message);
  const mailbox = accounts.find(a => a.id === message.account_id);
  const contactMatchesRecipient = Boolean(replyRecipient && data.contact && message.contact_id === data.contact.id && String(data.contact.email || '').trim().toLowerCase() === replyRecipient);

  return <Resource {...resource} retry={resource.reload}>
    {resource.refreshError && <p className="panel-note" role="status">This conversation could not refresh. Retrying automatically; your reply draft is kept.</p>}
    <div className="conversation-heading">
      <h2>{message.subject || '(No subject)'}</h2><div><MessageStatus message={message} /></div>
      <p>Mailbox: {mailbox?.email || (message.direction === 'outbound' ? message.from_email : message.to_email)}</p>
      <p>Conversation with: <strong>{replyRecipient || 'No reply address available'}</strong></p>
      {can('inbox:write') && <div className="conversation-management"><Field label="Assigned teammate"><select value={message.assigned_to || ''} onChange={e => { act(`/inbox/${id}`, patch({ assigned_to: e.target.value || null }), 'Conversation assignment updated.').catch(() => {}); }}><option value="">Unassigned</option>{users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field></div>}
    </div>
    {message.campaign_id && contactMatchesRecipient && <ReviewReply message={message} />}
    <div className="thread-messages">{thread.map((m: Row, i: number) => <article className={`thread-message ${m.direction === 'outbound' ? 'outbound' : ''}`} key={m.id || i}>
      <div className="thread-message-heading"><span className="avatar avatar-small">{initials(m.from_name || m.from_email || 'SD')}</span><div><strong>{m.from_name || m.from_email || 'Agency mailbox'}</strong><small>To {m.to_email || 'recipient'}</small>{m.direction === 'outbound' && <small><MessageStatus message={m} /></small>}</div><time>{date(m.accepted_at || m.received_at || m.created_at, true)}</time></div>
      <HtmlPreview html={m.body_html || m.html} text={m.body_text || m.text} />
    </article>)}</div>
    {can('inbox:write') && <form className="reply-composer" onSubmit={async e => {
      e.preventDefault();
      if (!message.id || !validEmail(replyRecipient)) return;
      setBusy(true); setError(''); setQueued('');
      try {
        await act(`/inbox/${id}/reply`, body({ body_text: reply }));
        setQueued(`Reply added to Outbox for ${replyRecipient}. Its sending status updates automatically.`);
        setReply('');
        processInbox('inbox', refresh, notify);
      } catch (err: any) { setError(err.message); } finally { setBusy(false); }
    }}>
      <h3><Send size={16} />Write a reply</h3><p>Reply to <strong>{replyRecipient || 'No reply address available'}</strong>{mailbox?.email ? <> from <strong>{mailbox.email}</strong></> : ''}.</p>
      <textarea aria-label="Reply message" rows={5} required maxLength={100000} disabled={busy || !validEmail(replyRecipient)} value={reply} onChange={e => setReply(e.target.value)} placeholder="Keep the conversation going…" />
      <div className="reply-footer"><span>Sending status updates automatically in Outbox.</span><Button type="submit" busy={busy} disabled={!message.id || !validEmail(replyRecipient) || !reply.trim()}><Send size={15} />Queue reply</Button></div>
      {!validEmail(replyRecipient) && <FormError error="This message has no valid reply address. Use New message to write to an email address." />}
      {queued && <div className="inbox-queue-confirmation" role="status"><CheckCircle2 size={16} /><span>{queued}</span></div>}
      <FormError error={error} />
    </form>}
  </Resource>;
}

function ReviewReply({ message }: { message: Row }) {
  const { can, act, notify } = useWorkspace(); const [action, setAction] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  if (!message.contact_id || message.direction !== 'inbound' || !['automatic', 'uncertain', 'delivery_failure'].includes(message.classification)) return null;
  if (message.reviewed_at) return <div className="inbox-review"><ShieldCheck size={17} /><div><strong>Reviewed · {message.review_action === 'resume' ? 'Resume approved; current safeguards still apply' : 'Outreach stopped'}</strong><p>{date(message.reviewed_at, true)}</p></div></div>;
  return <><div className="inbox-review"><ShieldCheck size={19} /><div><strong>This reply paused automated follow-ups for review.</strong><p>Read the message and check its meaning before deciding the next step.</p>{can('inbox:write') && <div className="review-actions"><Button variant="secondary" onClick={() => { setAction('resume'); setError(''); }}>Resume eligible follow-ups</Button><Button variant="ghost" onClick={() => { setAction('stop'); setError(''); }}>Stop outreach</Button></div>}</div></div>{action && <Modal title={action === 'resume' ? 'Resume after reviewing this reply?' : 'Stop automated outreach?'} description={action === 'resume' ? 'Resume only when the message does not require a human response or an opt-out. Consent, suppression, and any other unresolved reply can still block sending.' : 'Stop pending automated follow-ups for this contact across the agency.'} onClose={() => setAction('')}><form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { const result = await act<Row>(`/inbox/${message.id}/review`, body({ action })); notify(result.reason ? `Review recorded. ${result.reason}` : result.resumed ? 'Reply reviewed. Eligible follow-ups resumed.' : 'Reply reviewed and follow-up decision recorded.'); setAction(''); } catch (err: any) { setError(err.message); } finally { setBusy(false); } }}><label className="check-field"><input type="checkbox" required /><span><strong>I reviewed the message and verified this decision.</strong><small>{action === 'resume' ? 'This may make pending automated messages eligible again on their original mailbox.' : 'A future campaign must still respect this contact’s preferences.'}</small></span></label><FormError error={error} /><div className="form-footer"><Button variant="secondary" type="button" onClick={() => setAction('')}>Cancel</Button><Button busy={busy} type="submit">{action === 'resume' ? 'Confirm review & resume' : 'Confirm stop'}</Button></div></form></Modal>}</>;
}
