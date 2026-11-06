import {db,type Database} from './db.js';
import {getSettings} from './settings.js';

// SQL aggregate expressions can be returned as UTC strings by MySQL/MariaDB.
// Never send an unzoned database timestamp for the browser to interpret locally.
export function openTimestamp(value:unknown):string|null {
  if(!value)return null;
  const input=value instanceof Date?value:typeof value==='string'?new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)?value:value.replace(' ','T')+'Z'):null;
  return input&&!Number.isNaN(input.getTime())?input.toISOString():null;
}
export async function openSummaries(ids:string[],filterBots:boolean,trx:Database=db) {
  if(!ids.length)return new Map<string,any>();
  const filter=filterBots?1:0;
  const rows=await trx('tracking_events').whereIn('message_id',ids).where({kind:'open'}).select('message_id')
    .count({raw_open_count:'*'})
    .select(trx.raw('SUM(CASE WHEN ? = 0 OR bot = 0 THEN 1 ELSE 0 END) AS open_count',[filter]))
    .select(trx.raw('MIN(CASE WHEN ? = 0 OR bot = 0 THEN created_at END) AS first_opened_at',[filter]))
    .select(trx.raw('MAX(CASE WHEN ? = 0 OR bot = 0 THEN created_at END) AS last_opened_at',[filter])).groupBy('message_id');
  return new Map(rows.map((row:any)=>[row.message_id,{open_count:Number(row.open_count||0),raw_open_count:Number(row.raw_open_count||0),excluded_open_count:Number(row.raw_open_count||0)-Number(row.open_count||0),first_opened_at:openTimestamp(row.first_opened_at),last_opened_at:openTimestamp(row.last_opened_at)}]));
}
export const emptyOpenSummary={open_count:0,raw_open_count:0,excluded_open_count:0,first_opened_at:null,last_opened_at:null};
export async function messageOpenActivity(message:any,trx:Database) {
  const settings=await getSettings(trx);
  const summaries=await openSummaries([message.id],settings.filter_bots,trx);
  const events=await trx('tracking_events').where({message_id:message.id,kind:'open'}).select('id','created_at','bot').orderBy('created_at','desc').orderBy('id','desc').limit(50);
  return {message_id:message.id,to_email:message.to_email,subject:message.subject,open_tracking:!!message.open_tracking,is_test:!!message.is_test,
    ...emptyOpenSummary,...summaries.get(message.id),open_filter_enabled:settings.filter_bots,tracking_retention_days:settings.retention_days,workspace_timezone:settings.timezone,
    checked_at:new Date().toISOString(),events:events.map(event=>({id:event.id,recorded_at:openTimestamp(event.created_at),scanner:!!event.bot,excluded:settings.filter_bots&&!!event.bot}))};
}
