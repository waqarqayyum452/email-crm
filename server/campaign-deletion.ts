import {db} from './db.js';
import {up} from './migrations/011_campaign_deletion.js';
import {HttpError,audit} from './lib/util.js';
let provision:Promise<void>|undefined;
export function ensureCampaignDeletion(){return provision??=up(db).catch(error=>{provision=undefined;throw error;});}
export async function deleteCampaign(campaignId:string,actorId:string){
  await ensureCampaignDeletion();
  await db.transaction(async trx=>{
    await trx('business_settings').where({id:'agency'}).forUpdate().first();
    const campaign=await trx('campaigns').where({id:campaignId}).forUpdate().first();
    if(!campaign)throw new HttpError(404,'Campaign not found.');if(campaign.deleted_at)return;
    if(await trx('send_attempts').where({campaign_id:campaignId,status:'submitting'}).first())throw new HttpError(409,'An email in this campaign is being sent. Wait a moment and try deleting again.');
    const now=new Date(),reason='Campaign deleted';
    const attempts=await trx('send_attempts').where({campaign_id:campaignId}).select('job_id','status');
    const unknownIds=attempts.filter(attempt=>attempt.status==='unknown').map(attempt=>attempt.job_id);
    if(unknownIds.length)await trx('jobs').whereIn('id',unknownIds).whereIn('status',['queued','leased','failed','held','cancelled']).update({status:'held',lease_owner:null,lease_until:null,updated_at:now});
    await trx('jobs').where({campaign_id:campaignId}).whereIn('status',['queued','leased','failed','held']).modify(query=>{if(unknownIds.length)query.whereNotIn('id',unknownIds);}).update({status:'cancelled',last_error:reason,lease_owner:null,lease_until:null,updated_at:now});
    await trx('send_attempts').where({campaign_id:campaignId,status:'reserved'}).update({status:'cancelled',retryable:false});
    await trx('enrollments').where({campaign_id:campaignId}).whereIn('status',['active','paused']).update({status:'stopped',stop_reason:reason,updated_at:now});
    await trx('campaigns').where({id:campaignId}).update({status:'archived',deleted_at:now,updated_at:now});
    await audit(actorId,'campaign.deleted','campaign',campaignId,{name:campaign.name},trx);
  });
}
