'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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
export type ResourceOptions = { pollIntervalMs?: number; refreshOnFocus?: boolean; keepPreviousData?: boolean };
export function useResource<T = any>(path: string | null, revision = 0, options: ResourceOptions = {}) {
  const { pollIntervalMs = 0, refreshOnFocus = false, keepPreviousData = false } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [count, setCount] = useState(0);
  const loaded = useRef<{ path: string; data: T } | null>(null);
  useEffect(() => {
    let alive = true;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    if (!path) { loaded.current = null; setData(null); setError(''); setRefreshError(''); setLoading(false); setRefreshing(false); return; }
    const resourcePath = path;
    // Quiet refreshes keep forms mounted, including an unfinished Inbox reply.
    const hasData = () => keepPreviousData && loaded.current?.path === resourcePath;
    if (loaded.current?.path !== resourcePath) { loaded.current = null; setData(null); }
    setLoading(!hasData()); setError(''); setRefreshError('');
    const schedule = () => {
      clearTimer();
      // Start the next interval after completion, so slow requests never stack.
      if (alive && pollIntervalMs > 0 && !document.hidden) timer = setTimeout(() => { void fetchResource(); }, pollIntervalMs);
    };
    const fetchResource = async () => {
      if (!alive || controller) return;
      clearTimer();
      const request = new AbortController(); controller = request;
      let timedOut = false;
      if (pollIntervalMs > 0) requestTimer = setTimeout(() => { timedOut = true; request.abort(); }, 30000);
      setRefreshing(hasData());
      try {
        const value = await api<T>(resourcePath, { signal: request.signal });
        if (!alive) return;
        loaded.current = { path: resourcePath, data: value }; setData(value); setError(''); setRefreshError('');
      } catch (err: any) {
        if (!alive || (request.signal.aborted && !timedOut)) return;
        const message = timedOut ? 'The connection timed out.' : err.message || 'Unable to refresh.';
        if (hasData()) setRefreshError(message);
        else setError(message);
      } finally {
        if (requestTimer !== undefined) clearTimeout(requestTimer); requestTimer = undefined;
        if (alive) { controller = null; setLoading(false); setRefreshing(false); schedule(); }
      }
    };
    const resume = () => { if (!document.hidden) void fetchResource(); };
    const visibility = () => { if (document.hidden) clearTimer(); else resume(); };
    void fetchResource();
    if (pollIntervalMs > 0 || refreshOnFocus) {
      document.addEventListener('visibilitychange', visibility);
      window.addEventListener('online', resume);
    }
    if (refreshOnFocus) window.addEventListener('focus', resume);
    return () => {
      alive = false; clearTimer(); controller?.abort();
      if (requestTimer !== undefined) clearTimeout(requestTimer);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('focus', resume); window.removeEventListener('online', resume);
    };
  }, [path, revision, count, pollIntervalMs, refreshOnFocus, keepPreviousData]);
  const reload = useCallback(() => setCount(v => v + 1), []);
  return { data, error, refreshError, loading, refreshing, reload };
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
