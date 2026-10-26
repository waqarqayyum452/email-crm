import { db } from './db.js';
import { up } from './migrations/009_prospect_deletion.js';
let provision:Promise<void>|undefined;
export function ensureProspectDeletion(){return provision??=up(db).catch(error=>{provision=undefined;throw error;});}
