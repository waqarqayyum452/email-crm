# Testing and acceptance

## Formatted mailbox flow (2026-10-24)

Validation: 180 tests across 18 files and 24 production browser checks pass on isolated local MariaDB, with live sending disabled. TypeScript and production build pass; composer and incoming-message screenshots are reviewed.

The local regression suite covers safe paragraph/text styles, Unicode and emoji, underlined links, strict inline raster validation, duplicate/missing CID rejection, combined file limits, draft persistence, encrypted image storage and session-protected image downloads. A real Nodemailer stream transport generates MIME in memory; mailparser parses it again before ingestion into the isolated CRM. Assertions verify text paragraphs, HTML spacing/formatting, CID image bytes and a separate document attachment. No SMTP server or real recipient is involved.

Browser fixtures exercise plain-text clipboard newlines, automatic underlined URLs, image insertion at the cursor, draft reopening with embedded images, separate attachments, formatted incoming mail, authenticated image rendering, forwarding embedded images and external-image opt-in. Dashboard previews must never load their own open-tracking pixel. Synthetic addresses and images are used with live sending disabled.

Gmail and Outlook are not directly verified by these local tests. For a future authorized client check, send the same formatted sample to controlled Gmail and Outlook accounts, compare paragraphs, bold/italic/underline, emoji, clickable links, embedded image positions and document downloads, then reply from both clients and inspect the received CRM thread. Record client/version differences; do not claim pixel-identical rendering. Previously stripped stored HTML/images require reimporting original MIME to recover missing content.

Website branding (2026-10-23): the CRM reuses the agency website's SDWE wordmark, SVG favicon, Bagoss display fonts, royal-blue actions and sky-blue surfaces. Geist remains the reading/UI font. The isolated production browser walkthrough checks the real logo image, computed brand colors, phone-width login wrapping, desktop/sidebar branding, all dashboard routes, independent Inbox scrolling and mobile keyboard navigation with live sending disabled. Production build/typechecks pass; desktop and mobile screenshots are visually inspected.

Website lead integration (2026-10-23): the complete isolated MariaDB suite passes 170 tests across 16 files with fake mail transports. New checks cover Bearer authentication, consent injection rejection, default Prospect ownership/stage, inquiry notes, concurrent delivery deduplication, repeat inquiries without resetting suppression/consent, persisted outage recovery, cursor replay, and rejection of untrusted recovery URLs. The website's six isolated tests verify server-only key matching, whitelisted inquiry exports, endpoint pinning, delivery failure handling and authenticated bounded recovery queries. Both projects pass TypeScript and production builds. No test submits real email.

Automated tests must use fake transports, deterministic fixtures, and a disposable test database. They never submit live mail. Passing pure tests or a build does not prove MySQL locking, real credentials, scheduler continuity, or hosting compatibility. The final implementation report and [progress record](progress.md) distinguish executed checks from pending ones.

## Commands

```powershell
npm test
npm run build
npm run doctor
npm run test:integration
```

Database integration checks require `RUN_DB_TESTS=true` and a `DB_NAME` ending in `_test`. Inspect `tests/integration.test.ts` and `tests/engine-integration.test.ts` before enabling them; point only to an expendable schema. They can create/delete test rows and must never run against real CRM data. For example, in a dedicated terminal with private DB credentials already configured:

```powershell
$env:DB_NAME = 'email_crm_test'
$env:RUN_DB_TESTS = 'true'
npm run test:integration
Remove-Item Env:RUN_DB_TESTS
```

Create/grant that separate database first; do not point the test variable at production. Restore `DB_NAME` to the normal local database before running the app. Integration files run sequentially because they share and reset fixture state. Verify MySQL 8 and the actual Hostinger MariaDB build independently; do not treat one engine's pass as proof for the other. The doctor only checks basic queue SQL and locks; it does not run the concurrency suite or prove scheduler cadence.

## Next.js migration evidence

The production Next.js 16.4.2 build and both TypeScript checks pass. The isolated suite passes **122 tests across 9 files** with Vitest 5.0.5, including real MariaDB API/engine tests and native HTTP boundary tests. The dependency audit reports **0 vulnerabilities** across production and development dependencies.

The actual `next start` walkthrough passes **14 checks**, including native page/deep-link navigation, contact persistence, campaign/template editing, normal Inbox compose/reply without contacts, authenticated CSV downloads, unique CSP script nonces, Secure/HttpOnly/SameSite session cookies, public tracking, unsubscribe confirmation/one-click handling, legacy bookmark conversion and mobile layouts. Screenshots were visually inspected. The browser fixture uses generated credentials, production configuration with an explicit loopback origin, a separate local `*_ui_test` database, disabled live sending and no worker. It does not read the user's private `.env`, send email or verify public hosting/TLS. See [progress.md](progress.md) for remaining Hostinger release checks.

The Hostinger production-mode regression was also reproduced and checked: exporting `NODE_ENV=development` caused the original `/_global-error` prerender failure; after the launcher fix, a clean build under the same inherited value succeeds. The browser harness now starts through `scripts/next.mjs` with development mode supplied to its child, and all 14 checks pass with production Secure cookies. These checks exercise mode enforcement rather than assuming a dependency mismatch.

The production-only installation was separately verified on Node 24.22.0 using a fresh copy of tracked source, no private `.env` or generated build files, and `NODE_ENV=production`. `npm ci --omit=dev` completed with zero audit findings; all eight compiler/type dependencies resolved inside that isolated installation while Vitest and `tsx` were absent. `npm run build` then passed both TypeScript checks, Next.js compilation/prerendering, and CLI compilation into `dist`. Package versions were unchanged. This verifies the install/build path locally; it does not verify a Hostinger deployment or execute database maintenance or mail.

## Earlier implementation evidence

The recorded passes in this section predate the Next.js migration. They document earlier domain/database behavior; the current runtime's results are recorded separately above and in [progress.md](progress.md).

Node 24.22.0 and loopback MariaDB 11.4.8 were used for the passing production build/typecheck, migration CLI, database-backed API/engine checks, and browser walkthrough. All 60 tests passed across 6 files, including the SSRF destination checks. `npm audit --omit=dev` reported 0 production dependency advisories at verification time. Local doctor passed UTC/InnoDB/locking and certificate-verified SMTP/IMAP TLS 1.3 reachability without mailbox authentication or message submission. An isolated backup/restore compared 29 tables/54 fixture rows with identical values.

All 8 browser checks passed: owner login; contact create/reload and edit; note/task/stage persistence; settings save; template create/duplicate/sample preview; campaign draft, personalization and excluded unknown-consent contact; navigation; desktop/tablet/mobile overflow checks at 1024px and 390px. No observed page/runtime/API failures remained. The controlled fixture's unknown consent was intentionally preserved and excluded from sending. This is limited browser acceptance, not a comprehensive keyboard/screen-reader audit or proof of every action under every failure condition.

The suite uses real database persistence with fake mailbox transports. Separate loopback SMTP/MIME fixtures exercise the installed libraries, including a disconnect after full DATA with unknown acceptance. MySQL 8, the actual Hostinger account/runtime, real mailbox authentication, scheduled cron continuity and live delivery remain unverified. See [progress.md](progress.md) for the current evidence record.

The local `db:setup` helper has 12 passing tests in `tests/database-setup.test.ts`, covering account/password setup, secret preservation, rejected configuration, error redaction, and recovery when configuration writes fail. These tests use fake database connections and temporary configuration files; they do not read the user's `.env` or connect to the native database. The native MariaDB administrator login remains a private setup step. Run `npm.cmd test -- tests/database-setup.test.ts` to repeat this isolated coverage.

Separate disposable MariaDB 11.4.8 fixtures on loopback port 3308 also passed the helper and interactive CLI checks: repair of an existing account, login with the saved generated password, preservation of existing rows, denial of access to a similarly named sibling database, key replacement with no mailbox ciphertext, and key preservation when ciphertext exists. The fixture schemas/accounts were removed and the temporary server was stopped. The native service on port 3306 and the user's `.env` were not changed by these checks. The server TypeScript check passed after the helper changes.

After adding direct Inbox mail, the full isolated suite passed **100 tests across 7 files**, including 40 engine integration tests. Coverage includes compose and reply without a contact, replies despite an old incorrect contact link, immutable recipients, contactless message threads and reply ingestion, suppression/revocation at enqueue and send time, safe retries, permissions/CSRF, and unchanged campaign consent gates. Manual Inbox messages do not create contacts or upgrade consent. All SMTP submissions used fake transports. The production build and both TypeScript checks passed.

The expanded browser walkthrough passed **11 checks**, including direct compose to a new address, a reply without contact matching, and the compose modal at 390px width. Desktop Inbox and mobile composer screenshots were visually reviewed. The browser fixture kept sending disabled, started no worker, and confirmed zero send attempts. These checks used separate loopback test schemas; the real CRM database and mailbox were not changed. No database migration was needed for the Inbox changes.

After adding configurable API origins, the full isolated suite passed **113 tests across 8 files** and the production build/typecheck passed. The 12 origin tests cover exact-origin configuration, wildcard CORS without credential sharing, malformed origins, preflight handling, and continued session/CSRF enforcement without database access. The database-backed API check also verifies the actual middleware mount and scheduler exclusion. Tests used fake mail transports and the separate loopback MariaDB on port 3308, which was stopped afterward. No real mail was submitted. The local environment was then set to `ALLOWED_ORIGINS=*` and `LIVE_SEND_ENABLED=true` as requested; existing app/worker processes need a restart to load those values. Dashboard pauses and delivery gates remain in effect.

## Reproduce the isolated browser check

`tests/browser-check.mjs` starts the actual built Next.js application with `next start` on loopback port 3100, creates generated fixtures in a local database ending `_ui_test`, forces `LIVE_SEND_ENABLED=false`, and keeps automation paused. It exercises real page URLs and Route Handlers, not a separate fixture HTTP server. It never connects a real mailbox or launches a worker. It requires a loopback DB host and a user allowed to create that disposable schema; never use a real CRM schema or a credential intended for production. It generates a private random test owner/password internally rather than printing credentials.

With the test DB credentials configured privately in a dedicated shell:

```powershell
npm run build
$env:DB_HOST = '127.0.0.1'
$env:DB_NAME = 'email_crm_ui_test'
# Optional when Chrome is not in its default Windows installation path:
# $env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm run test:browser
```

Use Node 24 or Node 22.12+ on PATH for both the build and browser command. `npm run build` must complete both the `.next` web build and `build:tools` before running the browser check. Set `DB_PORT` to the actual local database port and `DB_USER`/`DB_PASSWORD` privately; the script creates/migrates only the guarded local test schema and leaves generated fixtures for inspection. Ensure port 3100 is available. `CHROME_PATH` can also select a locally installed compatible Chromium executable on another OS. Screenshots are written under `artifacts/`; inspect them with the check output. Restore normal local DB environment variables after the test, and remove the disposable schema only after reviewing its contents.

## Acceptance matrix

The items below are requirements for review, not a statement that every scenario has already run. Mark source coverage, automated execution, database integration, and manual/provider verification separately.

- [ ] Authentication: correct/incorrect owner login, modern password hash, expiry/logout, login throttling, no public signup, session cookie flags.
- [ ] Permissions: owner vs team settings/contact/campaign/inbox/system writes; read access; forbidden writes rejected server-side. Every dashboard mutation rejects missing session or CSRF.
- [ ] Secrets: encrypted credentials in SQL, omitted from every API response and log; blank update preserves secret; connection errors redact sensitive values.
- [ ] Connections: public pinned destination validation, blocked private IPv4/IPv6/metadata targets, approved ports, invalid certificates rejected; tests do not send mail.
- [ ] CSV: bounded/invalid input, escaped quoted cells/newlines, column mapping, normalization, duplicate detection including same-file/concurrent import, immutable confirmation, error CSV, formula-safe export.
- [ ] Consent: unknown/revoked/evidence-free records excluded; publicly listed addresses/imports are not permission; suppression survives editing/reimport and mailbox replacement.
- [ ] Personalization: known/custom field and fallback rendering; missing/unknown required placeholders block sending; no unresolved tokens submitted.
- [ ] Versions: published snapshots survive template/draft edits; explicit revisions change unsent work only and preserve accepted content/history.
- [ ] Queue concurrency: simultaneous workers cannot claim/send one job twice; enrollment-step uniqueness holds; lease expiry recovers abandoned safe work.
- [ ] Capacity: atomic rolling-cap reservation across simultaneous campaign/test/reply submissions; min interval/window/weekday/timezone; external-mail allowance caveat.
- [ ] Outcomes: SMTP accepted vs temporary/permanent/auth/provider-limit/unknown; bounded safe backoff; no automatic retry of unknown or submitted work after crash.
- [ ] Replies: In-Reply-To/References Message-ID matching, no subject-only matching, agency-wide cancellation, automatic/uncertain review pause, permanent-bounce suppression.
- [ ] IMAP: durable UID/UIDVALIDITY checkpoint, duplicates no-op, stale sync stops follow-ups, resume/restart from safe checkpoint.
- [ ] Unsubscribe: GET has no state change; confirmation/one-click POST suppress immediately without login; repeated requests idempotent; jobs canceled; no link rewriting as click.
- [ ] Tracking: opaque tokens, stored safe redirect destinations, unsafe schemes rejected, no arbitrary query redirect, raw/unique/bot-filter behavior, campaign tracking disable.
- [ ] Mailbox migration: old enrollments/conversations keep original sender, new default affects new campaigns, old mailbox still syncs.
- [ ] Recovery: restart during claim/before submit/after submit; ambiguous SMTP held; operator reconciliation audited and follow-ups scheduled only once.
- [ ] Scheduling: America/Los_Angeles DST spring gap/fall repeated hour, UTC persistence, minute/day boundaries, delay based on actual acceptance.
- [ ] Analytics: tests excluded from production counts, distinct message opens/clicks, automated replies separate, denominators coherent with filters.
- [ ] UI: persisted actions across refresh/restart, empty/loading/error/success states, table paging/sorting, import errors, keyboard access, responsive tablet and desktop, no fake chart data.

## Controlled manual checklist

The first part is local and sends nothing:

1. Start with a fresh supported database, migrate/bootstrap, and log in. Set the business profile, timezone and initial mailbox defaults. Keep mailbox inactive and sending disabled/paused.
2. Create a controlled contact with unknown consent. Refresh and restart; confirm persistence. Add note/task/deal and update pipeline/owner. Create a permission-limited user and verify rejected changes.
3. Import a CSV containing a valid controlled address, malformed address, duplicate and already-suppressed address. Map columns, preview, confirm, download error CSV, and repeat. Verify suppression persists and no enrollment/job appears automatically.
4. Build a draft with a missing merge field; confirm preview/launch explanations. Add a fallback and publish; edit the template and verify the approved version stays unchanged.
5. Run the worker with `LIVE_SEND_ENABLED=false`. Verify work remains safely held and health shows actual state. Validate the scheduler without browser access and verify restart recovery.

**Only after explicit authorization for sending**, use addresses you control (or documented opted-in recipients), one mailbox, a tiny sample, and the 20 cap:

1. Privately enter valid mailbox credentials. Validate connections and sync first. Record the actual provider limit and space used. Use a receiving mailbox you own, clearly mark the test, and record its consent/source evidence.
2. Enable the environment gate deliberately and unpause only the intended scope. Send a single test from the composer; confirm it consumes capacity and is excluded from campaign metrics. Inspect the received raw Message-ID, opt-out mechanism, plaintext/HTML rendering and sender association.
3. Launch a tiny controlled campaign. Confirm SMTP acceptance/time and one job for its next step. Reply from the controlled recipient; sync and verify human classification, conversation association, agency-wide cancellation and human-reply count.
4. Use controlled automatic reply and DSN fixtures (or the automated fake tests); confirm review hold, no human metric inflation, and permanent-bounce suppression without intentionally emailing nonexistent third-party addresses.
5. In a controlled received message, open the opt-out link and verify GET alone changes nothing. Confirm via POST, then verify suppression and canceled work. Reimport the same address and attempt enrollment; it must remain excluded.
6. With tracking enabled for the controlled campaign, inspect a token link and its stored destination. Disable tracking on another draft and verify no pixel/link instrumentation. Explain approximate metrics to the operator.
7. Simulate uncertain acceptance with the fake transport, not a real duplicate email. Confirm no automatic resend and audit owner reconciliation. Do not deliberately generate uncertain live SMTP outcomes.
8. Add a second authorized mailbox, validate it, and make it default. Verify a new draft selects it while the original conversation retains the old sender. Restore both gates to a paused/disabled state after testing unless ongoing operation is explicitly authorized.

Before production release also complete the [Hostinger evidence record](hostinger.md) and an isolated [restore rehearsal](operations.md). Keep sanitized screenshots/evidence privately; do not collect passwords, tokens, raw personal inbox contents or secret-bearing logs.

## Live Inbox verification (2026-10-21)

The final isolated suite passes150tests across13files on MariaDB11.4.8/port3308 with fake mail transports. New checks cover60-second sync cadence, overlapping sync deduplication, Inbox-only claims, manual mail outside campaign hours/pacing with actual delivery gates preserved, pre-submission claim deadlock recovery, atomic/idempotent live cutover including claim races, authenticated processing with CSRF/permissions, strict scheduler actions, status/body redaction, delivery states and private scheduler filesystem protections. No suite submits live mail. Production build/typechecks pass.

The production browser walkthrough passes15checks, including automatic incoming message updates in both list and selected conversation, draft preservation across a temporary503, hidden-page polling suspension, focus/online recovery without overlap, and accurate Outbox state. It runs on an isolated local _ui_test database with live sending disabled and no real mailbox credentials. Screenshots were inspected.

A further real-host cadence issue was reproduced: a cron starting0.1seconds earlier than the prior minute skipped receiving under elapsed-time comparison. UTC polling buckets now admit one scan per interval despite cron jitter, with pending/leased deduplication retained. The isolated regression checks59.548-second adjacent-minute ticks and no duplicate within the same minute.

## Workspace UI refresh (2026-10-21)

The production Next.js build and TypeScript checks pass with locally hosted variable Geist through next/font/local. The expanded production browser walkthrough passes 16 checks against a fresh isolated local _ui_test database with live sending disabled. It covers all dashboard routes, desktop/tablet/mobile layouts, actual font loading, search-icon/text clearance, collapsed Outbox expansion, contact/campaign/settings flows, automatic Inbox updates with draft preservation, keyboard focus trapping and Escape/navigation behavior. Desktop and mobile screenshots were reviewed. No backend contract, production configuration or mailbox credential changes are part of the visual refresh.

## Inbox scrolling and email conversations (2026-10-21)

The isolated MariaDB suite passes 159 tests across 14 files with fake mail transports. New tests cover reply-header chains, changed reply subjects, independent compose to the same address with the same subject, missing ancestors, malformed/cyclic references, mailbox/participant isolation, stable navigation anchors, latest-message reply anchors, delivery states and grouping before the 200-conversation limit. No schema migration is needed.

The production browser walkthrough passes 17 checks with live sending disabled and no real mailbox credentials. Inbox checks verify a fixed Outbox header, independent list/reader scrolling without page overflow, one row per reply chain, separate new conversations, draft preservation during updates/failures, latest-message reply submission, preserving the reading position when a reply arrives, jumping to the latest reply, and mobile list/reader navigation. Desktop and mobile screenshots are inspected; build and TypeScript checks pass.

The compact Inbox refinement reduces headers, list rows, message padding and the reply composer while retaining 15px message text. The production browser walkthrough now also checks usable space at 1366x768: approximately 491px for the email list, 86px per row, 415px for the message reader, and 83px for the reply composer. It checks that the mobile reader remains at least 400px high with a send confirmation visible. Laptop/mobile screenshots are reviewed; threading and sending behavior are unchanged.

## Mail tools verification (2026-10-21)

The Send button regression opens New message from All mailboxes without manually choosing From. It verifies the actual default mailbox value, recipient validation, explanations for missing recipient/subject/body, and an enabled Send button after completion. Forwarding must also preserve an inline reply through background processing callbacks; expanded replies retain their text and original source anchor.

The isolated suite passes 165 tests across 15 files with fake SMTP. Added checks exercise canonical bounded attachment decoding, filename/path validation, encrypted storage, sanitized rich content and signature snapshots, authenticated sandboxed downloads, MIME sender names and name reuse, private draft ownership and CSRF, atomic draft removal on enqueue, opt-in tracking, dashboard pixel removal, stable tracking/attachments on safe retry, and unchanged suppression/source-anchor gates. The migration is exercised on a database whose default collation differs from the original Knex table keys. Production build and TypeScript checks pass. No test sends real mail.

The production browser walkthrough passes 19 checks on a fresh isolated database with live sending disabled. It saves/reopens a formatted attachment draft, toggles bold formatting, edits a signature, verifies the tracking option and queued snapshot, opens a sender card, downloads a received attachment, forwards it into a separate compose, and submits an expanded reply with the original source anchor. Laptop scrolling space and mobile send-control visibility remain verified. Desktop/mobile screenshots were reviewed. These checks use fixture addresses and documents only.
