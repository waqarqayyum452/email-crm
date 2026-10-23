import { db, type Database } from '../db.js';
import { up } from '../migrations/006_inbox_folders.js';

let provision: Promise<void> | undefined;
export function ensureInboxFolders() {
  return provision ??= up(db).catch(error => { provision = undefined; throw error; });
}

export async function spamMessageIds(messageIds: string[], trx: Database = db) {
  if (!messageIds.length) return new Set<string>();
  const rows = await trx('inbox_spam').whereIn('message_id', messageIds).select('message_id');
  return new Set<string>(rows.map(row => row.message_id));
}
