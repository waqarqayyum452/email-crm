# Architecture and data model

## Structure

```text
app/                     Next.js App Router pages, persistent workspace layout, Node Route Handlers
client/                  Shared React dashboard components, navigation, authenticated API client
proxy.ts                 Next.js request nonce/CSP and security headers
server/app.ts            Web Request dispatcher, session/CSRF boundaries, bounded scheduler endpoint
server/http.ts           Framework-neutral routing and request/response helpers
server/auth.ts           owner/team access, hashed sessions, password verification
server/settings.ts       owner-editable business settings and encrypted mailbox configuration
server/contacts.ts       contacts, pipeline, notes, tasks, deals, suppression management
server/imports.ts        bounded CSV staging, validation, mapping, confirmation, error CSV
server/campaigns.ts      drafts, version publishing, templates, inbox actions
server/tracking.ts       public tracking and unsubscribe endpoints
server/engine/           durable queue, capacity reservations, SMTP, IMAP, matching, scheduling
server/db.ts             Knex/mysql2 connection and JSON decoding
server/lib/              validation, crypto, public mail destination restrictions, sanitization
server/migrations/       versioned relational schema
scripts/                 migrations, owner bootstrap, bounded worker, doctor, HTTP cron runner
tests/                   pure/fake-service checks and opt-in MySQL integration checks
docs/                    contracts, deployment, operations, verification status
public/                  downloadable import template
```

Next.js 16.4.2 App Router owns the HTTP server and serves React 19 pages and the same-origin API. Native page routes such as `/overview`, `/prospects/[id]`, `/campaigns/[id]` and `/inbox/[id]` reuse the domain components in `client/`; the workspace layout preserves the dashboard shell during navigation. `server/app.ts` dispatches Web Requests to the framework-neutral domain routers in `server/http.ts`, which enforce authorization, CSRF, validation and state transitions. Its `createApp` Node adapter is for fixtures, not the production server.

Node Route Handlers expose `/api/[[...path]]`, `/healthz`, `/internal/tick`, `/t/[kind]/[token]` and `/unsubscribe/[token]`. The Next.js proxy applies request-specific CSP nonces and security headers. Same-origin sessions, CSRF, permissions and configurable API-origin behavior remain in force.

MySQL holds all durable business state. Nodemailer submits SMTP messages; ImapFlow fetches incremental inbox messages; mailparser parses MIME. There is no Redis or external queue. The database schema, Knex/mysql2 layer, credential encryption and mail worker are unchanged by the Next.js migration, so no data migration is required. Development runs `next dev --webpack` on port 3000. Production runs `next start` after `npm run build`; `.next` contains the web build, while `dist/scripts/worker.js` and the other compiled CLI tools remain available for bounded private execution.

One agency can have one owner and permission-scoped team users. There are no tenant IDs or billing paths. A future OAuth provider can implement the mailbox transport boundary; OAuth is not implemented. A mailbox is a durable sender identity: changing the default applies to new campaigns only, and does not rewrite existing thread/enrollment associations.

## Relationships and indexes

UUID primary keys identify entities; foreign keys preserve references. Datetimes use UTC and millisecond precision. Business timezone controls scheduling only; conversion happens at the scheduling boundary. JSON settings and contact tag/custom-field values deliberately avoid separate join/value tables in this MVP; consent history and suppression remain normalized safety records.

| Area | Relationships and query support |
| --- | --- |
| Access | Users own sessions; unique normalized user email supports login. Session token hashes and expiry support authentication and cleanup. Users carry permission arrays; the owner has every permission. |
| Settings | One `business_settings` agency row holds editable settings; mailbox rows hold connection metadata and encrypted secrets. Owner-only changes are audited. |
| CRM | Unique normalized contact email prevents duplicate contacts. Contacts refer to owners/stages; notes, tasks, consent history and deals refer to contacts. Stage position supports ordered Kanban; one deal per contact avoids duplicate opportunity totals. |
| Imports | Imports preserve a staged snapshot and row results. Confirmation consumes the snapshot rather than accepting replacement client rows. Contact email uniqueness is the final concurrent duplicate guard. Suppression is consulted again on confirmation. |
| Campaigns | Campaigns refer to sender accounts. Published versions and ordered sequence steps preserve approved content. Enrollments link contact, campaign/version and sender; uniqueness prevents duplicate enrollment. Revisions explicitly affect unsent content only. |
| Queue | Due-job status/run-time/lease indexes support bounded claims; row locks and `SKIP LOCKED` keep independent runners from claiming the same work. Unique enrollment/step work prevents duplicate follow-ups. Lease expiry makes abandoned claims recoverable. |
| Sending | Each logical send attempt retains its reservation, stable Message-ID, outcome and acceptance time; immutable `send_attempt_events` preserve individual submission outcomes across retries. Attempt/ordinal/status uniqueness prevents duplicate history events. Capacity queries use mailbox and recent timestamps; the agency settings lock serializes reservations across runners. Unknown attempts remain counted/held until reconciliation. |
| Inbox | Checkpoints key mailbox/folder and retain UIDVALIDITY/last UID. Unique mailbox/Message-ID prevents duplicate ingestion across replayed UID ranges; indexed outbound Message-IDs support matching by In-Reply-To/References. Subject similarity never establishes a match. |
| Tracking | Unique unguessable message/link/unsubscribe tokens locate server-stored records. Link destinations are stored and validated, never supplied by redirect query strings. Raw event rows remain distinct from deduplicated/filtered aggregates. |
| Suppression | Unique normalized suppression email makes agency-wide send-time lookup and concurrent suppression idempotent. Reason/source/time are retained across imports and mailbox replacement. |
| Reporting | Message acceptance, event creation, classification and campaign/mailbox timestamps support date/campaign/mailbox filters. Audit entity/time indexes support sensitive-change review. |

The migration files are authoritative for concrete column and index names. Run all migrations against the exact supported database build before treating any schema or locking behavior as verified.

Inbox conversations are connected components of stored Message-ID, In-Reply-To and References headers, isolated by mailbox and normalized external address. A new compose without references starts a separate conversation even when its subject or recipient matches. A missing original ancestor can still connect replies, while known references to other participants are ignored. The earliest server-created member supplies the navigation ID; existing member URLs remain valid. The list groups header metadata before applying its 200-conversation limit and loads only the latest text preview per conversation; full bodies are loaded for the selected thread. This uses existing message records and requires no schema migration. Header grouping currently scans the selected mailbox's metadata on reads, so very large mail histories will need persisted/indexed conversation membership.

## Sending state machine

1. A bounded runner safely claims due work with a lease.
2. It checks campaign/mailbox state, recorded consent and provider policy, suppression, human/review reply state, fresh inbox synchronization, sending window, min interval, and rolling capacity.
3. It reserves capacity atomically, writes a send attempt, and assigns a stable Message-ID before submission.
4. Immediately before SMTP submission it rechecks database eligibility. Acceptance is persisted before the next follow-up is scheduled from the actual acceptance time.
5. Proven safe temporary failures can retry with bounded backoff. Authentication/provider-limit/permanent failures have distinct handling. A connection failure with uncertain SMTP acceptance becomes **unknown**, is held, and never automatically resends.

SMTP has no atomic transaction with MySQL. A crash between SMTP acceptance and persistence can leave an ambiguous attempt. Leases cannot make this exactly once. An owner reconciles unknown attempts using provider logs or mailbox evidence; proving `not_sent` permits a deliberate retry, while `accepted` preserves the history and schedules the next step. Reconciliation is audited.

Human replies stop pending automated outreach agency-wide for the contact. Automatic and uncertain replies pause for review and are excluded from human-reply metrics. An explicit audited inbox review can authorize resuming eligible paused work; it cannot bypass a human-reply stop or suppression. A recipient-specific permanent delivery report suppresses the address; ambiguous/delayed reports require review. UIDVALIDITY changes require resynchronization with deduplication, and incomplete/failed sync remains unhealthy until full catch-up. An incoming reply may arrive between the last sync and submission; database rechecks reduce this race but cannot eliminate IMAP detection latency.

## Security boundaries

- Passwords are hashed; opaque session cookies are HttpOnly, expire, and are Secure in production. The database stores session hashes rather than reusable cookies. All state-changing dashboard routes require both an authenticated session and CSRF token.
- Owner bootstrap runs locally/privately without public signup. Team permissions are checked on the server. Configuration cannot disable encryption, TLS verification, authorization, or send-time suppression.
- Mailbox passwords are encrypted using the environment's 32-byte key, omitted from API responses, and redacted from application error output. A blank credential update means preserve the saved secret.
- Mail connection tests allow approved mail ports and public destinations only; public DNS is resolved/checked and the connection is pinned while certificate identity is verified for the original hostname. Tests must not expose internal networks.
- HTML previews and parsed inbound HTML are sanitized; remote images are disabled by default. SQL uses bound parameters/Knex values. CSV input is bounded and exports escape spreadsheet formulas.
- Public open/click endpoints use opaque tokens and do not expose raw recipient emails. GET unsubscribe displays confirmation without changing state; confirmation POST and supported one-click POST immediately suppress/cancel outreach without login.
- The scheduler is a separate Bearer-authenticated route, compared safely and excluded from cookie CSRF. Its credential belongs only in environment/stdin or a private file consumed by the runner, never in URL query strings, command arguments, access logs, or dashboard JSON.

## Deletion and retention

Archive campaigns/templates and pause mailboxes instead of deleting history. Suppression and consent/audit evidence must survive ordinary contact edits, imports, sender changes, and analytics cleanup. No UI exposes suppression removal. Do not cascade-delete a sender's historical messages, campaigns or conversations.

Each worker tick deletes raw open/click events older than the configured retention interval. Suppression, consent, campaign versions, message/delivery history and audit evidence are retained; this is not a general contact-erasure or mailbox-cleanup service. Verify retention against the actual database and running scheduler before relying on it operationally. No attachment bodies are stored in MySQL and no attachment workflow is included. Establish a documented retention/erasure process appropriate to the agency before using real contact data; this implementation does not establish legal compliance by itself.
