import { db, type Database } from '../db.js';
import { audit, id, normalizeEmail } from '../lib/util.js';
import { z } from 'zod';

export const consumedStatuses = ['reserved','submitting','accepted','unknown'];

// Operator-written one-to-one mail does not enroll or upgrade CRM contacts.
// Address-level opt-outs still apply even when no contact is attached to a job.
export async function manualRecipientEligibility(recipient:string,account:any,trx:Database=db):Promise<string|null> {
  if(account?.deleted_at)return 'Mailbox has been deleted. Connect a mailbox before sending.';
  if(!z.string().email().max(254).safeParse(recipient).success)return 'Enter a valid recipient email address';
  const email=normalizeEmail(recipient);
  if(await trx('suppressions').where({email}).first())return 'Address is suppressed agency-wide';
  const contact=await trx('contacts').where({email}).first();
  if(contact?.consent_status==='revoked')return 'Consent for this address has been revoked';
  if(!account||account.provider_policy!=='opt_in_only')return 'Unsupported provider policy';
  return null;
}

export async function stopContact(contactId: string, reason: string, status: 'stopped'|'paused' = 'stopped', trx: Database = db) {
  const now = new Date();
  const enrollments = await trx('enrollments').where({contact_id:contactId}).whereIn('status',['active','paused']).select('id');
  if (enrollments.length) {
    await trx('enrollments').whereIn('id',enrollments.map(e=>e.id)).update({status,stop_reason:reason,updated_at:now});
    await trx('jobs').whereIn('enrollment_id',enrollments.map(e=>e.id)).whereIn('status',['queued','leased']).update({status:'cancelled',last_error:reason,lease_owner:null,lease_until:null,updated_at:now});
  }
}

export async function suppressEmail(email: string, reason: string, source: string, actorId?: string | null, existingTrx?: Database) {
  const run = async (trx: Database) => {
    const normalized = normalizeEmail(email);
    // Same global lock as reservation serializes new suppression with send eligibility.
    await trx('business_settings').where({id:'agency'}).forUpdate().first();
    await trx('suppressions').insert({id:id(),email:normalized,reason,source,created_at:new Date()}).onConflict('email').ignore();
    const contact = await trx('contacts').where({email:normalized}).first();
    if (contact) {
      await stopContact(contact.id,reason,'stopped',trx);
      if (reason === 'unsubscribe') {
        await trx('contacts').where({id:contact.id}).update({consent_status:'revoked',updated_at:new Date()});
        await trx('contact_consents').insert({id:id(),contact_id:contact.id,status:'revoked',source,evidence:'Unsubscribe confirmation',created_at:new Date()});
      }
    }
    const suppression=await trx('suppressions').where({email:normalized}).first();
    await audit(actorId,'suppression.add','suppression',suppression.id,{reason,source},trx);
    return suppression;
  };
  return existingTrx ? run(existingTrx) : db.transaction(run);
}

export async function contactEligibility(contact: any, account: any, trx: Database = db, options: {reply?:boolean} = {}): Promise<string | null> {
  if (!contact||contact.deleted_at) return 'Contact no longer exists';
  if (await trx('suppressions').where({email:contact.email}).first()) return 'Address is suppressed agency-wide';
  if (!['opted_in','test'].includes(contact.consent_status)) return 'Documented opt-in or controlled-test consent is required';
  if (contact.consent_status === 'opted_in' && !contact.consent_evidence?.trim()) return 'Opt-in evidence is required';
  if (account.provider_policy !== 'opt_in_only') return 'Unsupported provider policy';
  if (!options.reply) {
    const previous = await trx('messages').where({contact_id:contact.id,direction:'inbound'}).where(builder=>builder.where('classification','human_reply').orWhere(inner=>inner.whereIn('classification',['automatic','uncertain','delivery_failure']).where(review=>review.whereNull('review_action').orWhereNot('review_action','resume')))).first();
    if (previous) return 'Prior reply requires manual review; automated outreach is stopped agency-wide';
  }
  return null;
}
