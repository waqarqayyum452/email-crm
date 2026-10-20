import { randomUUID, createHash } from 'node:crypto';
import type { Database } from '../db.js';
import { db } from '../db.js';
export const id = () => randomUUID();
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export class HttpError extends Error { constructor(public status: number, message: string, public details?: unknown) { super(message); } }
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
const sensitive = /password|secret|token|authorization|cookie|credential|encryption_key/i;
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, sensitive.test(k) ? '[REDACTED]' : redact(v)]));
  return value;
}
export async function audit(userId: string | null | undefined, action: string, entityType: string, entityId: string | null | undefined, details: unknown = {}, trx: Database = db) {
  await trx('audit_logs').insert({id:id(), user_id:userId || null, action, entity_type:entityType, entity_id:entityId || null, details:JSON.stringify(redact(details)), created_at:new Date()});
}
export function csvCell(value: unknown) {
  let text = value == null ? '' : String(value);
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
export function csvRows(rows: unknown[][]) { return '\uFEFF' + rows.map(row=>row.map(csvCell).join(',')).join('\r\n'); }
export function safeError(error: unknown) {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  const allowed = ['EAUTH','ECONNREFUSED','ENOTFOUND','ETIMEDOUT','ESOCKET','ECONNECTION','ETLS','EENVELOPE'];
  return allowed.includes(code) ? `Connection failed (${code}). Check server, TLS, and credentials privately.` : 'Operation failed. Check connection configuration and system health.';
}
