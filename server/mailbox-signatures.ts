import { db } from './db.js';
import { up } from './migrations/007_mailbox_signatures.js';

let provision: Promise<void> | undefined;
export function ensureMailboxSignatures() {
  return provision ??= up(db).catch(error => { provision = undefined; throw error; });
}
