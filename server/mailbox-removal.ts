import { db } from './db.js';
import { up } from './migrations/004_mailbox_removal.js';

let provision: Promise<void> | undefined;
export function ensureMailboxRemoval() {
  return provision ??= up(db).catch(error => { provision = undefined; throw error; });
}
