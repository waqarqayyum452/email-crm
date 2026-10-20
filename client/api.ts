'use client';

import { useEffect, useState } from 'react';

export type Row = Record<string, any>;
export type Session = { user: { id: string; name: string; email: string; role: string; permissions: string[] } | null; csrfToken: string };
let csrf = '';
export function setCsrf(value: string) { csrf = value; }
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())) headers.set('x-csrf-token', csrf);
  const response = await fetch(`/api${path}`, { ...options, headers, credentials: 'same-origin' });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof data === 'object' ? data.error : data;
    if (response.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('session-expired'));
    const details = Array.isArray(data?.details) ? data.details.map((issue: Row) => `${(issue.path || []).join(' ') || 'Input'}: ${issue.message}`).join(' · ') : Array.isArray(data?.details?.excluded) ? data.details.excluded.slice(0, 8).map((c: Row) => `${c.email || 'Contact'}: ${c.reason}`).join(' · ') : '';
    const error = new Error(`${message || `Request failed (${response.status})`}${details ? ` ${details}` : ''}`);
    Object.assign(error, { details: data?.details });
    throw error;
  }
  return data as T;
}
export const body = (data: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(data) });
export const patch = (data: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(data) });
export function list(data: any): Row[] { return Array.isArray(data) ? data : data?.items || []; }
export function useResource<T = any>(path: string | null, revision = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    if (!path) { setLoading(false); return; }
    setLoading(true); setError('');
    api<T>(path).then(value => { if (alive) setData(value); }).catch(e => { if (alive) setError(e.message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [path, revision, count]);
  return { data, error, loading, reload: () => setCount(v => v + 1) };
}
export function date(value: any, time = false) {
  if (!value) return 'Not yet';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, time ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', year: 'numeric' }).format(parsed);
}
export const money = (value: any, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(value || 0));
export function initials(value: string) { return (value || '?').split(/\s+/).slice(0, 2).map(v => v[0]).join('').toUpperCase(); }
export function contactName(contact: Row) { return [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.company_name || contact.email || 'Unnamed contact'; }
