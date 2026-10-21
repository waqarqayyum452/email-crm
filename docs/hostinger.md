# Hostinger deployment and verification

Deployment, DNS changes and live mail require explicit owner authorization. Keep credentials private and preserve the mailbox encryption key during transfers. No alternate provider is selected automatically.

## What the documentation proves

Checked against official Hostinger documentation on **2026-10-20**:

- Business and Cloud Web Apps offer Node 18/20/22/24 and Next.js support. Select **Node 24 LTS**, or Node 22 only if the actual patch version is at least 22.12.0; the older article asserting VPS-only Node support is obsolete for Business Web Apps. This confirms the product capability, not this account's actual runtime. [Current Web App guide](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/), [Business availability announcement](https://www.hostinger.com/changelog/nodejs-hosting-now-available-on-business-plans-and-higher).
- Hostinger documents environment-configured Node/database access and server-app restart controls. Actual app/SSH/cron environments may differ. [Node database configuration](https://www.hostinger.com/support/connecting-a-hostinger-mysql-database-to-a-node-js-application/).
- The current Node deployment guide says Business/Cloud installs and builds run during deployment and npm commands cannot be run through SSH. Verify a supported private release/runtime mechanism for migrations, owner bootstrap, diagnostics, and worker execution; do not assume an SSH npm session or CLI cron can run them. [Node deployment guide and FAQ](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/).
- **The exact database remains an open verification gate.** Hostinger's database-engine article states Web/Cloud uses MariaDB, while its Node guide calls the service MySQL. To keep the existing hosting, this project retains Knex/mysql2 and targets MySQL 8+ **or MariaDB 10.11+** rather than silently moving to another database service. Obtain `SELECT VERSION()` from the real application connection, then verify migrations, JSON behavior, locks, and concurrency tests on that exact version. A shared wire protocol alone does not prove compatibility. [Database engine article](https://www.hostinger.com/support/1583226-which-database-management-system-is-used-at-hostinger/).
- Custom cron exists and its schedule uses UTC. That does not prove the Web App's Node binary, dependencies, variables, private files, or working directory are reachable by cron. [Cron setup](https://support.hostinger.com/en/articles/1583465-how-to-set-up-a-cron-job-at-hostinger), [cron troubleshooting](https://www.hostinger.com/support/1583514-troubleshooting-cron-jobs-at-hostinger/).
- The documented mail defaults are SMTP implicit TLS `smtp.hostinger.com:465` and IMAP implicit TLS `imap.hostinger.com:993`. They do not prove this runtime can reach those ports or that credentials are valid. [Configuration details](https://support.hostinger.com/en/articles/1575756-how-to-get-email-account-configuration-details-for-hostinger-email).
- The user's confirmed free-mail allowance is 100 per rolling 24 hours, 1 GB, and 15,000 stored messages. Confirm current hPanel allowance before release; account limits can change. The application begins at 20. [Provider limits](https://support.hostinger.com/en/articles/4625828-parameters-and-limits-of-hostinger-email).
- Hostinger prohibits unsolicited email to non-opted-in recipients. Test only with addresses you control or contacts with recorded permission, and keep the provider boundary replaceable. [Hostinger mass-mailing policy](https://www.hostinger.com/support/1583510-is-mass-mailing-supported-at-hostinger/).

## Evidence record before choosing a scheduler

Record sanitized evidence in a private operator record. Do not capture passwords, encryption keys, session cookies, or scheduler tokens.

| Check | How to verify | Acceptance gate |
| --- | --- | --- |
| Web App runtime | hPanel runtime selection plus `node --version` from the app execution context | Node 24 or Node 22.12+ actually executes the build/start paths |
| Database | Built `node dist/scripts/migrate.js`, `node dist/scripts/doctor.js`, critical integration tests on a disposable database with development dependencies installed | Exact MySQL 8+ or MariaDB 10.11+ version, migrations, UTC clock and transaction/lock semantics pass |
| Public mail network | `node dist/scripts/doctor.js` from the built Web App runtime | Public DNS and certificate-verified TLS handshakes on SMTP465/IMAP993 succeed |
| Mail credentials | Private Settings connection validation | Both services authenticate; no message sent |
| Build/start | Private build logs and `/healthz` | Next.js framework, project root, `npm ci`, `npm run build`, `npm start`; dashboard and API share origin |
| Release commands | Verify a supported private execution mechanism in this account | Migrations, fresh-database bootstrap and doctor can run with the correct database/secrets; SSH npm access is not assumed |
| Variables | Doctor plus login and encrypted credential save/read-use | Variables reach both deployed server and chosen scheduler without leaking to frontend |
| Restart | Use hPanel's server-app restart after queuing non-sending work | Session/data persist; lease recovers; unknown SMTP work stays held |
| Idle/timeout | Observe health before/after closed browser and inactivity; measure bounded runner completion | API runtime wakes/remains accessible; runner finishes within verified host timeout |
| Cron | Run selected runner manually, then scheduled, then with browser closed | At least three consecutive scheduled heartbeats with expected cadence, no access-token logs |
| Overlap | Invoke two non-sending workers against test data | No duplicate claim/reservation; overlap remains bounded |
| Mailbox storage | hPanel current storage/count and monitoring process | Operator knows capacity and cleanup policy; CRM does not claim provider-quota introspection |

`doctor` gives sanitized JSON for Node, required environment, MySQL version and UTC drift, advisory-lock availability, queue `SKIP LOCKED` SQL support, and public SMTP/IMAP TLS reachability. It authenticates to MySQL but never authenticates to a mailbox or sends a message. A successful TLS handshake is not a successful inbox sync or deliverability test. It does not prove concurrent reservation correctness; the integration suite does.

## Future deployment procedure (requires authorization)

When moving existing data, pause the old CRM, disable its sending gate and scheduler, and stop writes before the final consistent database export. Keep the old instance disabled through cutover: two independent copies of the queue must never send concurrently. Preserve the matching encryption key with any copied mailbox ciphertext. Replacing that key requires deliberate private re-encryption or re-entry of mailbox credentials; a fresh key is appropriate only when no copied credentials depend on the old one.

1. Preserve a tested source revision and lockfile. Exclude `.env`, database dumps, credentials, local logs, and `node_modules` from uploads. Repository integration or ZIP upload are both supported; do not enable automatic production redeployment until its migration/restart behavior is understood.
2. Select the **Next.js** Web App framework and Node 24; root directory is the repository root. Installation is `npm ci`, build is `npm run build`, and start is `npm start` (`next start`). TypeScript and the required application type packages are in `dependencies`, so the build also supports `npm ci --omit=dev` with `NODE_ENV=production`. It runs TypeScript checks, `next build --webpack`, then `build:tools` to compile the private CLI tools into `dist`. Use Hostinger's automatic Next.js entry/output defaults (`.next`). Remove any old custom `server.js` or `dist/server/index.js` entry override; Next.js owns the HTTP server. This is a server application, not a static export.

   When development dependencies are omitted, run the built CLI entries: `node dist/scripts/migrate.js`, `node dist/scripts/bootstrap.js`, `node dist/scripts/doctor.js`, and `node dist/scripts/worker.js` through the verified private execution mechanism. The npm aliases for those tools use development-only `tsx`; tests also require `npm ci --include=dev`. Keep `NODE_ENV=production` during install, build and runtime.
3. Create the database/user in hPanel and read its actual host/name/username. Set `DB_*` variables privately. Do not assume `127.0.0.1` or a local account's credentials work inside the managed app. For remote DB TLS set `DB_SSL=true` and the appropriate trusted CA, never disable certificate verification. Verify the database engine before migrating production data.
4. Set `NODE_ENV=production`, `APP_URL=https://crm.sandiegowebsiteexperts.com`, `SCHEDULER_BASE_URL` to the same HTTPS origin, `LIVE_SEND_ENABLED=false`, and the hPanel-provided `PORT` where applicable. A panel-exported `NODE_ENV=development` was locally reproduced causing `/_global-error` prerender failure with `Cannot read properties of null (reading 'use')`; correct it before redeployment. The npm build/start launcher also enforces production mode before loading Next/React. Preserve `ENCRYPTION_KEY` when importing encrypted mailbox credentials; otherwise generate a fresh key. Generate a fresh `SCHEDULER_SECRET` and update every approved scheduler caller. Set `TRUST_PROXY_HOPS` only after checking the real reverse-proxy topology; do not blindly trust every forwarded IP. Production Secure cookies require HTTPS.

   Keep `APP_URL` as the actual dashboard/link URL. Blank `ALLOWED_ORIGINS` permits its origin; comma-separated exact canonical HTTP(S) origins add trusted API origins, and `*` accepts any valid HTTP(S) API origin. CORS applies only to `/api` and omits `Access-Control-Allow-Credentials`; same-origin cookie sessions, CSRF and permissions remain, so wildcard access does not enable a separately hosted authenticated frontend. Restart after changing environment values. Initial setup/staging stays at `LIVE_SEND_ENABLED=false`; deliberately authorized live operation uses `true` after restart and still requires dashboard unpause, allowed windows/caps, validated mailbox, fresh sync, recipient eligibility and a working worker.
5. Verify the account's supported private release-command mechanism first; the current Hostinger guide does not support npm through SSH. Run the built migration deliberately against the chosen database (`node dist/scripts/migrate.js` where supported). Bootstrap privately only for a fresh database without an owner; an imported owner must retain the existing login. The built bootstrap entry point is `node dist/scripts/bootstrap.js` where supported. Supply the owner password through a private prompt or secret environment and clear it afterward. Do not place owner credentials in a GitHub build log.
6. Start/restart the service. Run the doctor and the evidence checks above in its actual runtime. Verify `/healthz`, login, settings, contact persistence, CSRF, secure cookie, and sanitized secret-free logs. Confirm the `crm.sandiegowebsiteexperts.com` origin and TLS only within the separately authorized deployment/DNS scope.
7. Choose and prove one scheduler below. Verify heartbeat age and stale-inbox behavior with sending disabled. Create an inactive account with the documented initial mailbox defaults and enter its password privately. Test connections and sync without sending.
8. Back up and perform an isolated restore rehearsal. Only after explicit live-mail authorization run the controlled-address checklist, unpause settings/mailbox as required, and enable the environment gate. Production campaigns remain subject to consent, policy, suppression, capacity, and recent-sync checks.

## Scheduler candidates — select only after verification

There is no permanent in-process interval as the sole scheduler. Each tick has a configured work budget (HTTP budget at most 20 seconds); queue state, leases, retries and heartbeat live in MySQL. That budget controls new-work admission: already-running database/network calls can extend wall-clock time, so measure the real upper duration under failure conditions against the host timeout. The HTTP caller's 25-second abort does not terminate backend work. A minute cadence may be suitable, but confirm the plan's permitted minimum and configured inbox interval first. Host cron is UTC while campaign sending windows use the business timezone.

**Candidate A: custom CLI cron.** Only after proving this account's cron can execute Node with the app's dependencies, database and private environment, schedule an absolute-path wrapper outside the public web root. Cron availability alone does not prove this execution path, and SSH npm access is not assumed:

```sh
#!/bin/sh
set -eu
cd /absolute/private/application/root
exec /verified/path/to/node dist/scripts/worker.js
```

Use the actual verified paths; `dist/scripts/worker.js` is generated by the TypeScript build. The wrapper must load secrets privately through cron environment or a restrictive `.env` in its working directory. Do not copy environment secrets into the hPanel command field. Use the host's custom-cron UI to run the wrapper and set only its cadence. Do not launch an unmonitored long-running SSH worker or assume PM2 is available.

**Candidate B: authenticated HTTP cron.** If app execution is isolated but cron can run Node and outbound HTTPS, a private wrapper can execute:

```sh
#!/bin/sh
set -eu
cd /absolute/private/application/root
exec /verified/path/to/node scripts/scheduler-call.mjs
```

`SCHEDULER_BASE_URL` points to the app HTTPS origin. `SCHEDULER_SECRET` comes from a private environment/`.env`. Alternatively, `node scripts/scheduler-call.mjs --secret-stdin < /absolute/private/scheduler-secret` reads a restricted secret file; the path contains no secret. Set private file permissions (for example 0600) and ensure it is outside public content. The runner rejects insecure non-loopback HTTP, does not follow redirects, times out at 25 seconds, does not retry internally, and prints only status/timing. Ensure upstream logging redacts `Authorization`; do not use `curl -v`, query-string tokens, URL userinfo, or an inline token in a cron command. A later cron tick can safely inspect leases; it must never force-resend an unknown attempt.

If neither mechanism executes reliably under the current plan, scheduled sending is blocked. Document the exact unavailable capability and review a compatible no-recurring-cost scheduling arrangement with the owner; do not silently switch hosting or add a paid scheduler.

## Automatic live Inbox

The Inbox refreshes its list, Outbox and selected conversation every 10 seconds while visible, retaining reply drafts across refresh failures. A compose/reply queues durable work and requests an immediate bounded Inbox worker. A server cron is still required to receive mail and finish pending work when the browser is closed. Incoming mail normally appears within about one minute plus the screen refresh; this is polling, not guaranteed instant IMAP push. Manually written messages skip campaign business hours and campaign pacing, while live/global pause, validated mailbox, fresh sync, exact-recipient suppression/revocation, rolling capacity and unknown-acceptance holds remain. Campaign timings are unchanged.

The optional Hostinger installer uses NODE_ENV=production, HOSTINGER_ACCOUNT and HOSTINGER_SCHEDULER_DIR. The latter must exactly equal /home/<account>/domains/<APP_URL hostname>/.email-crm-scheduler. An authenticated scheduler install action writes tick.php and scheduler.json there with directory0700/files0600, outside public_html and rotating build directories. The PHP CLI wrapper reads the private secret, takes a nonblocking lock and sends a certificate-verified HTTPS POST with mode=inbox. It refuses redirects and times out after25seconds, printing only safe status/timing/counters. The cron command contains only `/usr/bin/php /home/<account>/domains/<domain>/.email-crm-scheduler/tick.php`, scheduled `* * * * *`. Confirm actual execution and three advancing receiving heartbeats before considering it operational. [Hostinger PHP cron format](https://www.hostinger.com/support/5646919-how-to-set-up-a-cron-job-with-special-characters-at-hostinger/).

With live sending disabled, use scheduler action=status for private counters, action=install for the fixed installer, and mode=sync for a receiving-only test. For an explicitly authorized Inbox cutover, set LIVE_SEND_ENABLED=true and call action=activate-inbox once. This atomic operation refuses active sending leases, holds existing queued sends for review, sets receiving interval60 and unpauses outgoing mail. It does not send or release old messages; repeating it does not disturb new jobs. The installed cron claims only sync and manually written Inbox jobs, never campaign/test jobs. Review campaign automation separately. Unknown SMTP acceptance always needs manual reconciliation.
