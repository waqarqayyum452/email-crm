'use client';

import Link from 'next/link';
import { Children, cloneElement, isValidElement, useEffect, useId, useRef, type ReactElement, type ReactNode } from 'react';
import { AlertCircle, ArrowRight, Check, ChevronRight, Inbox, LoaderCircle, X } from 'lucide-react';
import { date, type Row } from './api';

export function Button({ children, variant = 'primary', busy, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; busy?: boolean }) {
  return <button {...props} className={`button ${variant} ${props.className || ''}`} aria-busy={busy || undefined} disabled={props.disabled || busy}>{busy && <LoaderCircle size={16} className="spin" />}{children}</button>;
}
export function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function Status({ value }: { value: any }) {
  const status = String(value || 'unknown');
  const tone = ['active', 'accepted', 'opted_in', 'completed', 'valid', 'won', 'human_reply', 'healthy', 'connected'].includes(status) ? 'green' : ['failed', 'error', 'invalid', 'revoked', 'permanent_failure', 'lost', 'suppressed'].includes(status) ? 'red' : ['paused', 'unknown', 'excluded', 'inactive', 'automatic_reply', 'automatic', 'held', 'stale', 'waiting'].includes(status) ? 'amber' : 'blue';
  return <Badge tone={tone}><span className="status-dot" />{status.replace(/_/g, ' ')}</Badge>;
}
export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description: string; actions?: ReactNode }) {
  return <div className="page-header"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1><p>{description}</p></div><div className="page-actions">{actions}</div></div>;
}
export function Panel({ children, title, subtitle, actions, className = '' }: { children: ReactNode; title?: string; subtitle?: string; actions?: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>{(title || actions) && <div className="panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{actions}</div>}{children}</section>;
}
export function Empty({ title = 'Nothing here yet', description = 'Your activity will appear here as you get started.', action }: { title?: string; description?: string; action?: ReactNode }) {
  return <div className="empty"><div className="empty-icon"><Inbox size={25} /></div><h3>{title}</h3><p>{description}</p>{action}</div>;
}
export function ErrorBox({ error, retry }: { error: string; retry?: () => void }) {
  return <div className="error-box" role="alert"><AlertCircle size={20} /><div><strong>We couldn’t complete that request</strong><p>{error}</p>{retry && <button className="text-button" onClick={retry}>Try again <ArrowRight size={14} /></button>}</div></div>;
}
export function Loading() { return <div className="loading"><LoaderCircle className="spin" size={22} /><span>Loading your workspace…</span></div>; }
export function Resource({ loading, error, children, retry }: { loading: boolean; error: string; children: ReactNode; retry?: () => void }) { return error ? <ErrorBox error={error} retry={retry} /> : loading ? <Loading /> : <>{children}</>; }
export function Modal({ title, description, children, onClose, wide = false }: { title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLElement>(null); const close = useRef(onClose); close.current = onClose; const titleId = useId();
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); if (e.key === 'Tab') { const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, iframe') || [])].filter(element => element.offsetParent !== null); const first = focusable[0], last = focusable.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } } };
    window.addEventListener('keydown', handler);
    const previous = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', handler); document.body.style.overflow = previous; if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`modal ${wide ? 'wide' : ''}`}><div className="modal-header"><div><h2 id={titleId}>{title}</h2>{description && <p>{description}</p>}</div><button autoFocus className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20} /></button></div><div className="modal-body">{children}</div></section></div>;
}
export function Field({ label, hint, children, className = '' }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  const generated = useId(); const nodes = Children.toArray(children);
  const index = nodes.findIndex(node => isValidElement(node) && ['input', 'select', 'textarea'].includes(String(node.type)));
  const control = index >= 0 ? nodes[index] as ReactElement<{ id?: string; 'aria-describedby'?: string }> : null;
  const controlId = control?.props.id || `${generated}-control`;
  if (control) nodes[index] = cloneElement(control, { id: controlId, ...(hint ? { 'aria-describedby': `${control.props['aria-describedby'] || ''} ${generated}-hint`.trim() } : {}) });
  return <div className={`field ${className}`} {...(!control ? { role: 'group', 'aria-labelledby': `${generated}-label` } : {})}>{control ? <label className="field-label" htmlFor={controlId}>{label}</label> : <span className="field-label" id={`${generated}-label`}>{label}</span>}{nodes}{hint && <small id={`${generated}-hint`}>{hint}</small>}</div>;
}
export function Detail({ label, children }: { label: string; children: ReactNode }) { return <div className="detail"><span>{label}</span><strong>{children || '—'}</strong></div>; }
export function FormError({ error }: { error: string }) { return error ? <div className="form-error" role="alert"><AlertCircle size={16} />{error}</div> : null; }
export function SaveFooter({ busy, label = 'Save changes', onCancel }: { busy?: boolean; label?: string; onCancel?: () => void }) { return <div className="form-footer">{onCancel && <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>}<Button type="submit" busy={busy}><Check size={16} />{label}</Button></div>; }
export function Timeline({ items }: { items: Row[] }) {
  return items.length ? <div className="timeline">{items.map((item, i) => <div className="timeline-item" key={item.id || i}><span className="timeline-dot" /><div><strong>{String(item.description || item.action || item.type || item.subject || 'Activity').replace(/[._]/g, ' ')}</strong>{(item.email || item.detail || item.entity_type) && <p>{String(item.email || item.detail || item.entity_type).replace(/_/g, ' ')}</p>}<small>{date(item.created_at || item.at, true)}</small></div></div>)}</div> : <Empty title="A fresh start" description="New messages and contact updates will appear in your activity timeline." />;
}
export function LinkArrow({ href, children }: { href: string; children: ReactNode }) { return <Link className="text-link" href={href}>{children}<ChevronRight size={15} /></Link>; }
export function HtmlPreview({ html, text }: { html?: string; text?: string }) { return html ? <iframe className="email-preview" title="Email preview" sandbox="" referrerPolicy="no-referrer" srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;"><style>body{font:14px/1.65 system-ui;color:#293544;padding:20px;overflow-wrap:anywhere}a{color:#366b73}</style>${html}`} /> : <div className="plain-preview">{text || 'No message content.'}</div>; }
