import { db } from '../db.js';
import { up } from '../migrations/005_inbox_reads.js';

let provision: Promise<void> | undefined;
export function ensureInboxReads() {
  return provision ??= up(db).catch(error => { provision = undefined; throw error; });
}

export async function readMessageIds(userId: string, messageIds: string[]) {
  if (!messageIds.length) return new Set<string>();
  const rows = await db('inbox_reads').where({ user_id: userId }).whereIn('message_id', messageIds).select('message_id');
  return new Set<string>(rows.map(row => row.message_id));
}
