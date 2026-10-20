# Operations, backups, and troubleshooting

## Safe daily operation

Review System health before enabling a campaign: scheduler heartbeat, inbox sync age, account state, queued/failed/unknown attempts, and rolling capacity. Keep the default 20 application cap until there is a deliberate reason to change it. Treat provider 100 as a ceiling, with room for webmail/other-client usage; the CRM cannot comprehensively reconcile those external sends.

For initial setup/staging, keep `LIVE_SEND_ENABLED=false`. Deliberately authorized live sending requires `LIVE_SEND_ENABLED=true` and a restart of the app and any worker process; dashboard pauses, sending windows/caps, an active validated mailbox, fresh sync, recipient eligibility and worker execution still apply. Local enablement is separate from hosting deployment.

`ALLOWED_ORIGINS` controls API-only CORS: blank allows the `APP_URL` origin; comma-separated exact canonical HTTP(S) origins add trusted origins; `*` accepts any valid HTTP(S) API origin. Keep `APP_URL` as the actual dashboard/link URL and restart after changes. CORS omits `Access-Control-Allow-Credentials`; cookie sessions stay same-origin, with CSRF and permissions enforced, so wildcard access does not enable a separately hosted authenticated frontend.

Inspect campaign exclusions and rendered personalization before launch. Unknown/revoked consent and suppression exclude a recipient. Source or public availability is not consent. Test and reply messages use the same account capacity path. A contact import creates CRM records only and never enrolls a campaign.

For individual correspondence, use **Inbox → New message** or reply directly in a conversation. Manual Inbox mail requires no prospect or contact matching and does not create campaign opt-in. Enter the recipient directly for a new message; replies keep the original external address and mailbox. Suppressed addresses and revoked consent remain blocked. Queued messages still need the worker and all delivery gates; on a local installation run `npm.cmd run worker:once` in a second terminal. `--sync-only` processes receiving only.

For a sending incident: pause automation and affected campaigns/mailboxes first. Preserve logs, attempt IDs, stable Message-IDs, timestamps and provider evidence, without copying secrets. Failed safe work can use the health retry action; unknown SMTP attempts require owner reconciliation. Do not delete or directly reset an unknown job to pending. If the sender reports a later permanent bounce, keep its suppression. Automatic/uncertain replies and unconfirmed delivery reports stay paused until an authorized explicit inbox review; resuming reviewable work cannot reactivate a suppressed contact or override a human-reply stop.

When reconciling unknown SMTP acceptance, choose **accepted** only with evidence that the provider accepted the message. An optional verified acceptance timestamp (`accepted_at`) can be recorded from provider evidence; it must fall between the attempt's reservation and the current time. If the actual timestamp is unknown, acceptance is recorded at confirmation time conservatively, so capacity and the next follow-up are not released early. This can place the accepted metric in the confirmation period rather than the original submission period. Choosing **not sent** is an explicit decision that queues a retry; use it only with evidence of non-submission, because an incomplete Sent-folder view is not proof. Both decisions remain subject to the send-time gates and an audit record.

For mailbox replacement: add and validate the new mailbox, test only with authorized controlled addresses, then make it default for new campaigns. Keep the old mailbox connected for reply monitoring and historical threads. Do not change old enrollment/account references in SQL. OAuth and attachment handling are deferred.

## Backup scope and schedule

Back up database state, the exact deployed revision/lockfile/migration history, and the **separately protected encryption key**. Include suppressions, consent history, all jobs/reservations/attempts, messages, checkpoints, campaign versions, audit events, and settings. Database backups alone cannot decrypt saved mailbox passwords without the same key. Mail-server mailbox contents are separate from the CRM database and need the provider's own backup/export process.

Keep encrypted backups outside the public web root, with restricted access. Define the agency's acceptable recovery-point and recovery-time objectives; a practical starting policy is a daily encrypted database backup plus one before every migration/release, with periodic restore rehearsals. Confirm provider backup frequency/retention rather than assuming it covers the app. No automatic backup daemon is included here.

Use a native client appropriate to the actual engine (`mysqldump` for MySQL, `mariadb-dump` for MariaDB), with a minimally privileged backup user. `--password` without a value prompts privately and keeps the password out of process arguments. The following is an operator example; replace host/user/database privately with real values, and confirm the account has the required privileges:

```sh
mysqldump --host=DB_HOST --port=3306 --user=BACKUP_USER --password \
  --single-transaction --quick --no-tablespaces --hex-blob \
  --default-character-set=utf8mb4 --result-file=/private/backups/crm.sql DB_NAME
```

For MariaDB use the same common flags with `mariadb-dump`. The app schema uses InnoDB; do not run concurrent schema migrations during a transactional dump. Encrypt the dump using an agency-approved encryption tool and verify its checksum/readability. A backup contains sensitive contact data and may contain recoverable mailbox credentials when combined with the key. Never serve the SQL file from `public/`, include it in Git, or upload it as an application artifact. hPanel database export is an alternative if shell clients are unavailable; verify a full export and isolated restore.

## Restore procedure

1. Stop scheduler invocations, set `LIVE_SEND_ENABLED=false`, pause automation, and take a snapshot of the damaged environment. Preserve any post-backup suppression events and provider acceptance evidence; restoration must never resurrect known opt-outs.
2. Create an **isolated** supported database and least-privileged app user. Restore the matching source revision and protected encryption key. Keep the restored app inaccessible to ordinary users and disconnected from real sending until review finishes.
3. Restore the SQL using the correct engine client. A portable interactive alternative is `mysql --host=DB_HOST --user=RESTORE_USER --password DB_NAME`, followed by `SOURCE /private/backups/crm.sql;` inside that client's prompt. Do not paste credentials into the `SOURCE` statement. Use `mariadb` for a MariaDB restore. Do not restore over production until the rehearsal succeeds and replacement is authorized.
4. Verify table counts, migrations, owner login, contacts, suppressions, encrypted mailbox credential usability, campaign versions, message history, and queue state. Apply only reviewed forward migrations required by the release.
5. Merge all confirmed suppressions after the snapshot and reconcile attempts that might have been SMTP-accepted since the backup. **Old queue state can otherwise resend a message already accepted after the snapshot.** Hold uncertain attempts and compare Message-IDs/provider logs before allowing a retry. A database restore is not evidence that an email was never sent.
6. Run the doctor, then bounded non-sending worker passes and incremental inbox sync. Confirm checkpoint/UIDVALIDITY handling and stale-sync alerts. Perform browser checks with sending disabled. Record the restore duration and any lost interval.
7. Re-enable only the previously approved scheduler and separately authorized sending after operator review. Rotate exposed credentials when relevant, but do not overwrite the encryption key until existing secrets have been deliberately migrated.

Migration rollback can drop records and is not a restore strategy. `npm run db:rollback` is for disposable development databases or a reviewed rollback with a verified backup. Never use `docker compose down -v` for routine shutdown; it destroys local database volumes. Use `docker compose stop` when preserving local data.

## Troubleshooting

| Symptom | Checks and safe action |
| --- | --- |
| API 503 / cannot start | Confirm Node 24 or Node 22.12+, install/build success, root working directory, `dist/server/index.js`, assigned port, and sanitized server error code. Node 22.11 is too old for patched dependencies. This must be a server/Express Web App. |
| Database access denied | Check actual hPanel host/user/name, user grants, environment availability and strict TLS trust. Do not print passwords or full connection URLs. Restart after variable changes. |
| Unsupported version / SQL error | Capture only version and sanitized code. Run migrations against disposable MySQL 8+/MariaDB 10.11+; verify `SKIP LOCKED`, JSON reads/writes and queue engine. Older MariaDB is not claimed supported. |
| Tables missing | Run `npm run db:migrate` against the intended database; verify migration history. Never use schema reset against real data. |
| Login loops / CSRF403 | Match `APP_URL` and browser origin, use HTTPS in production, confirm Secure cookies and trusted proxy configuration, fetch a fresh session/CSRF token. Do not disable CSRF. |
| Credential decryption fails | Confirm the original 32-byte base64 encryption key is loaded unchanged. Restore the protected key; if unavailable, enter mailbox credentials again privately. |
| Connection test rejected | Use approved SMTP/IMAP ports and a public mail hostname. Private, loopback, metadata/link-local destinations and invalid certificates are intentionally blocked. Do not disable TLS verification. |
| Doctor TLS failure | From the actual app runtime check outbound465/993 availability, DNS and certificates with provider support. A local network test says nothing about hosting egress. |
| No sends | Check environment gate, global pause, campaign/mailbox active state, consent evidence, suppression, sending timezone/window, capacity, spacing, and fresh inbox sync. Show the specific exclusion/hold reason. |
| Follow-ups held | Sync the original mailbox; review automatic/uncertain replies and stale-sync alerts. An owner cannot bypass a suppression by importing again. |
| Heartbeat stale | Verify cron execution identity, absolute Node/app paths, environment, logs and timeouts. Run one bounded pass; prove repeated scheduling with browser closed. |
| Worker overlap / lease expiry | Inspect timestamps and long-running network operations; database leases recover abandoned safe jobs. Do not release an ambiguous SMTP attempt by hand. |
| Unknown send outcome | Look up its stable Message-ID in provider logs/sent mailbox. Owner marks accepted or demonstrably not sent through reconciliation; absence from an incomplete view is not proof. |
| SMTP authentication/provider limit | Correct credentials privately or wait for rolling allowance; pause the mailbox. Do not rotate accounts or exceed provider restrictions. |
| IMAP UIDVALIDITY changed | Allow controlled rescan/deduplication; inspect checkpoint and sync status. Do not count replayed messages again. |
| Inbox count differs from webmail | Check the configured folder, incremental checkpoint and unmatched list. Attachments/folder browsing/full mailbox replication are not provided. |
| Opens/clicks look high | Review raw vs filtered events; privacy prefetchers and scanners are expected. Do not treat these events as verified human engagement or auto-qualify leads. |
| Mailbox full | Use hPanel/provider storage tools. CRM history does not reclaim server storage; never delete old mail without the agency's retention decision. |

Operator diagnostics should contain IDs, timestamps, classifications and allowlisted error codes. Avoid raw SMTP/IMAP transcripts, request bodies, cookie values, authorization headers, MIME blobs, or database URLs in shared logs.
