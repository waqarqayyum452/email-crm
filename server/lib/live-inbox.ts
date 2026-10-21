import { db } from '../db.js';
import { config } from '../config.js';
import { getSettings } from '../settings.js';
import { audit, HttpError } from './util.js';

/** Scheduler diagnostics contain counters and mailbox state, never mail or credentials. */
export async function liveInboxStatus() {
  const [settings, state, accounts, counts, unknown, detailsReady, draftsReady] = await Promise.all([
    getSettings(), db('worker_state').where({ id: 'scheduler' }).first(),
    db('email_accounts').select('id', 'status', 'verified_at', 'last_sync_at', 'last_successful_sync_at', 'last_error'),
    db('jobs').select('kind', 'status').count({ count: '*' }).groupBy('kind', 'status'),
    db('send_attempts').where({ status: 'unknown' }).count({ count: '*' }).first(),
    db.schema.hasTable('message_details'),db.schema.hasTable('mail_drafts'),
  ]);
  return {
    live_send_enabled: config.liveSendEnabled, paused: settings.paused,
    poll_interval_seconds: settings.poll_interval_seconds, last_heartbeat: state?.last_heartbeat || null,
    accounts: accounts.map(({ last_error, ...account }) => ({ ...account, has_error: !!last_error })),
    jobs: counts.map((row:any) => ({ kind: row.kind, status: row.status, count: Number(row.count) })),
    unknown_attempts: Number(unknown?.count || 0),
    mail_storage_ready: detailsReady && draftsReady,
  };
}

/** One-time, explicit cutover: never releases messages queued before activation. */
export async function activateLiveInbox() {
  if (!config.liveSendEnabled) throw new HttpError(409, 'Enable the private live-send setting before activating Inbox.');
  return db.transaction(async trx => {
    await trx('business_settings').where({ id: 'agency' }).forUpdate().first();
    const marker = await trx('worker_state').where({ id: 'inbox-live-cutover-v1' }).first();
    if (marker) return { activated: true, already_activated: true, activated_at: marker.updated_at };
    // Lock the pending rows before checking leases: claimJob uses SKIP LOCKED,
    // so an old queued message cannot become leased between this check and hold.
    const pending = await trx('jobs').where({ kind: 'send' }).whereIn('status', ['queued', 'leased']).select('id', 'status').forUpdate();
    if (pending.some(job => job.status === 'leased')) {
      throw new HttpError(409, 'Wait for the active sending worker to finish before activating Inbox.');
    }
    const timestamp = new Date();
    const held = await trx('jobs').where({ kind: 'send', status: 'queued' }).update({
      status: 'held', lease_owner: null, lease_until: null,
      last_error: 'Held during live Inbox cutover. Review before retrying.', updated_at: timestamp,
    });
    const settings = await getSettings(trx);
    await trx('business_settings').where({ id: 'agency' }).update({
      data: JSON.stringify({ ...settings, paused: false, poll_interval_seconds: 60 }), updated_at: timestamp,
    });
    await trx('worker_state').insert({ id: 'inbox-live-cutover-v1', updated_at: timestamp });
    await audit(null, 'inbox.live_activated', 'system', 'inbox', {
      held_existing_jobs: held, scheduler_scope: 'manual_inbox_only', poll_interval_seconds: 60,
    }, trx);
    return { activated: true, already_activated: false, held_existing_jobs: held, activated_at: timestamp };
  });
}
