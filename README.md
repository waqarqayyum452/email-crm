# San Diego Website Experts · Email CRM

A single-agency Next.js App Router application with React 19/TypeScript, Node Route Handlers, and MySQL-backed email workflows. The application is local only until deployment is explicitly authorized. No public signup, Redis, external analytics, SaaS billing, paid AI dependency, live-mail test suite, or automatic hosting changes.

Initial identity: **San Diego Website Experts**, `sandiegowebsiteexperts.com`, mailbox `info@sandiegowebsiteexperts.com`; the planned production origin is `https://crm.sandiegowebsiteexperts.com`.

The default application cap is **20 messages per rolling 24 hours**, with a configured provider ceiling of 100. Follow-ups, CRM replies, and test messages consume capacity. Mail sent outside the CRM also consumes the provider allowance; the CRM cannot reliably observe all such usage. Hostinger sending is limited to your own test addresses and contacts with recorded opt-in evidence. Importing an address does not create consent or enroll it in a campaign.

**Hosting is not verified.** Current Hostinger documentation supports Business Web Apps with Node.js and identifies the shared database engine as MariaDB. The application uses Knex/mysql2 with MySQL 8+ or MariaDB 10.11+ compatibility as a deployment target; the actual database version and integration results, outbound mail ports, cron/runtime access, and restart behavior remain release gates. See [Hostinger verification and deployment](docs/hostinger.md). No flowchart PDF was present among the available attachments; the detailed text request is the functional reference.

## Local setup

Use Node.js 24 LTS (or Node 22.12+), npm, and MySQL 8+ or MariaDB 10.11+ (Docker Desktop is optional). Earlier Node 22 builds such as 22.11 do not support the patched dependency chain. Commands below run from this repository. No command sends mail.

```powershell
Copy-Item .env.example .env
npm install
```

Edit `.env` privately. Set `DB_PASSWORD` and `DB_ROOT_PASSWORD` to independent local database passwords if using Docker. Generate independent keys with these commands and paste each value directly into your local `.env`; do not send the output through chat, logs, screenshots, or source control:

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"
```

Run that command separately for `ENCRYPTION_KEY` and `SCHEDULER_SECRET`. The encryption key must decode to exactly 32 bytes. The scheduler secret must contain at least 32 random characters. Preserve the encryption key with secure backups: replacing it makes existing mailbox credentials unreadable. Sessions use opaque random tokens; only their hashes are persisted in the database.

Start the optional local database, migrate, and create the owner:

```powershell
docker compose up -d mysql
npm run db:migrate
npm run bootstrap
npm run dev
```

For a local MariaDB compatibility target instead, set `DB_PORT=3307` in `.env`, then run `docker compose --profile hostinger-compat up -d mariadb` before migration. It uses a separate MariaDB 11.4 container/volume. If using an existing supported server, skip Docker and configure its database/user first. The bootstrap command uses `OWNER_EMAIL`, `OWNER_NAME`, and an interactive private password prompt (or `OWNER_PASSWORD` supplied privately by the environment). There is no public registration endpoint. Remove bootstrap-only passwords from the environment after use.

Open `http://localhost:3000`. Next.js serves the dashboard and API together; use `APP_URL=http://localhost:3000` locally. Dashboard routes are real URLs such as `/overview`, `/prospects` and `/prospects/<id>`, with direct links and refresh support. `npm run dev` runs Next.js with webpack. Build and start in a production environment configured with the actual HTTPS `APP_URL` and private secrets:

```powershell
npm run build
npm start
```

`npm run build` runs TypeScript checks, builds Next.js into `.next`, then compiles the server/CLI tools into `dist` through `build:tools`. `npm start` runs `next start`; no custom HTTP server entry is required. Existing database tables, mailbox ciphertext, jobs and records are retained by this framework migration; it requires no new data migration. See [progress](docs/progress.md) for the validation status of the Next.js build.

The `scripts/next.mjs` launcher selects production mode for build/start and development mode for dev before loading Next or React. Keep Hostinger's `NODE_ENV=production` as well, including when its platform starts Next directly. React and React DOM are pinned together at 19.3.1 with React 19.3 type packages; the committed lockfile preserves the tested dependency tree. Root-layout failures use the standalone `app/global-error.tsx` fallback.

Use `npm run dev` for ordinary local HTTP use. Production startup uses Secure cookies and requires an HTTPS dashboard URL. The isolated browser check provides a separate HTTP test environment without touching real CRM credentials or enabling mail.

`ALLOWED_ORIGINS` controls API CORS. Leave it blank to allow the `APP_URL` origin, add comma-separated exact canonical HTTP(S) origins to trust additional origins, or use `*` to accept any valid HTTP(S) API origin. `APP_URL` remains the actual dashboard/link URL. CORS sends no `Access-Control-Allow-Credentials`; sessions remain same-origin and CSRF/permissions still apply, so wildcard access does not enable a separately hosted authenticated dashboard. Restart the app after changing these variables.

During initial setup or staging, keep `LIVE_SEND_ENABLED=false` and Sending paused. Log in, edit the business profile, create an inactive mailbox, then create a contact. Enter mailbox credentials only in the private Settings form; saving returns no credentials. Connection validation authenticates to the configured SMTP/IMAP server but does not send a message. The safer connectivity-only doctor performs TLS handshakes without mailbox authentication:

```powershell
npm run doctor
npm test
```

`doctor` requires a migrated supported database and outbound network access. A failing network check is a diagnostic failure, not evidence that the UI or unit tests cannot work. See [testing and acceptance](docs/testing.md) for database integration tests and remaining verification.

For deliberately authorized live sending, set `LIVE_SEND_ENABLED=true` in the local environment and restart the app and any worker process. Dashboard pause controls, sending windows/caps, an active validated mailbox, recent inbox sync, recipient eligibility, and worker processing still apply. This setting does not deploy the CRM or change the initial setup defaults.

## Native Windows database login setup

If MariaDB is installed directly on Windows and the CRM reports `Access denied`, run this from the project folder in Command Prompt:

```bat
npm.cmd run db:setup
```

Enter the **MariaDB root password chosen during installation** at the hidden terminal prompt. The command supports local MySQL 8+/MariaDB 10.11+ only. It preserves tables/records, configures the dedicated CRM account for local connections, verifies a freshly generated app password, and saves that password directly in `.env`. It never prints passwords or stores the root password. Keep the CRM server stopped during this setup, and reload `.env` in the editor after it finishes.

The helper replaces the scheduler secret. It replaces the encryption key only when no encrypted mailbox credentials depend on it; existing encrypted mailbox data causes that key to be preserved. If old keys have been exposed and mailbox data already exists, arrange deliberate re-encryption before replacing its key. Update any existing local scheduler caller after changing its secret.

Then run `npm.cmd run db:migrate`. If setup is interrupted after changing an account, it retains the generated configuration in ignored `.env.setup-pending` instead of losing the new password. Review that file locally and follow its recovery message; never share either environment file. A pre-existing pending file blocks another setup run until its state is resolved.

To fetch incoming messages locally, choose the mailbox in **Inbox**, click **Sync inbox**, then run this in a second Command Prompt:

```bat
npm.cmd run worker:once -- --sync-only
```

This runs only inbox-sync jobs and does not process outgoing email jobs. Reload the Inbox afterward; a first sync of a large mailbox can require more than one pass. The app reads the mailbox's `INBOX` folder. New mail without a matching CRM conversation can appear as **Unmatched** or **Needs review**.

## Write email from Inbox

Use **Inbox → New message**, choose a connected sending mailbox, enter **To**, **Subject**, and **Message**, then queue the message. Open an incoming conversation to reply directly to its sender. No prospect creation or manual contact matching is required for these one-to-one messages. Replies retain their original mailbox and recipient.

Manual Inbox messages do not create contacts or grant campaign opt-in. Suppressed addresses and revoked consent remain blocked. Campaigns and campaign tests keep their documented consent requirements. The sending gate, automation pause, mailbox validation, recent inbox sync, sending window, spacing and rolling capacity still apply to Inbox delivery.

While running locally, use `npm.cmd run worker:once` in a second terminal to process queued messages. The `--sync-only` option fetches incoming mail only. Queuing a message is not confirmation of SMTP acceptance or delivery.

## Scheduled processing

Jobs persist in MySQL and survive browser closure. A scheduler must invoke a bounded worker repeatedly; the web process alone does not provide durable recurring execution.

For a local, manual pass:

```powershell
npm run worker:once
```

For a local authenticated HTTP pass against the running API:

```powershell
node scripts/scheduler-call.mjs
```

The HTTP runner reads `SCHEDULER_BASE_URL` (or `APP_URL`) and `SCHEDULER_SECRET` from the environment/`.env`. It accepts secrets through stdin with `--secret-stdin`; never put secrets in a URL or command argument. It sends one POST and prints only status/timing. Select CLI cron or authenticated HTTP cron only after proving the account's runtime paths, environment, timeout, and cron cadence. Details are in [Hostinger instructions](docs/hostinger.md).

## Working documents

- [Architecture, schema, and security boundaries](docs/architecture.md)
- [Module/API contracts](docs/contracts.md)
- [Hostinger verification and future deployment](docs/hostinger.md)
- [Daily operation, backup, restore, and troubleshooting](docs/operations.md)
- [Metrics and their denominators](docs/metrics.md)
- [Acceptance checklist and test boundaries](docs/testing.md)
- [Implementation progress, limitations, and deferred work](docs/progress.md)
- [CSV import template](public/import-template.csv)

The source and automated checks are distinct from a production acceptance result. In particular, SMTP acceptance is not confirmed delivery, exactly-once mail delivery is not promised, and simulated tests do not prove real Hostinger compatibility.
