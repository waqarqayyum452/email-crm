import {db} from './db.js';
import {up} from './migrations/012_campaign_timing.js';
let provision:Promise<void>|undefined;
export function ensureCampaignTiming(){return provision??=up(db).catch(error=>{provision=undefined;throw error;});}
