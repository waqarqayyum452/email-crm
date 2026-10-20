# Progress and verification record

This record distinguishes implemented source, executed local checks, and private hosting verification. Phases 1–6 are implemented and exercised locally; this is not a deployment, live-mail acceptance result, or provider approval. The detailed text attachment is the functional reference because no flowchart PDF was available.

## Phases

The phase evidence and completed test counts below describe the implementation before its Next.js migration. The domain behavior and data remain in place; earlier passes do not establish that the new HTTP runtime is verified.

| Phase | Source status | Executed evidence / boundary |
| --- | --- | --- |
| 1 | Implemented: schema, owner login, encrypted mailbox settings, connection validation, manual contact | Migration CLI and MariaDB API tests passed; browser login/contact persistence passed. Mailbox authentication is mocked, not verified with real credentials. |
| 2 | Implemented: contact detail, mapped/staged CSV imports, suppression, pipeline, notes/tasks/deals | Validation/import/suppression tests passed on real MariaDB; browser contact edits, notes/tasks and stage persistence passed. |
| 3 | Implemented: templates, draft campaigns, audience exclusions, merge fields, immutable published versions | Version/personalization engine tests passed; browser template create/duplicate/preview and campaign draft/render/exclusion checks passed. |
| 4 | Implemented: durable queue, SMTP adapter, atomic caps, bounded retries, unknown holds and outcome history | MariaDB concurrency/reservation/restart tests and fake SMTP tests passed. Actual loopback DATA-disconnect fixture confirmed unknown/no automatic retry. |
| 5 | Implemented: incremental IMAP, UIDVALIDITY/dedup, reply stops, review/resume, recipient-specific bounce suppression | Fake IMAP/MIME fixtures and database reply/cancellation tests passed. Real inbox authentication, provider folders and full mailbox behavior remain unverified. |
| 6 | Implemented: tracking, unsubscribe, analytics, health, safe retry/reconciliation | Public endpoint/redirect/GET-vs-POST and reconciliation tests passed; production build/browser navigation passed. Engagement remains approximate. |
| 7 | Local diagnostics and restore verified; Hostinger verification pending | Local TLS-only SMTP/IMAP doctor and isolated backup/restore passed. Account runtime, actual engine build, authenticated mailbox, cron/idle/restart behavior and controlled live mail remain pending. |

## Executed environment and results

Validation used an isolated **Node 24.22.0** runtime and **MariaDB 11.4.8** bound to loopback. Disposable schemas separated API/engine acceptance, browser fixtures, and restoration. No real SMTP/IMAP credentials or production contacts were used.

| Check | Result |
| --- | --- |
| Dependency installation / production dependency audit | Lockfile installed; `npm audit --omit=dev` reported 0 advisories at verification time. This does not cover all development dependencies or future disclosures. |
| TypeScript and production build | Passed using Node 24.22.0. |
| Final reconciliation refinement | Production build/typecheck and all 13 focused real-database engine tests passed again after adding verified acceptance timestamps and conservative confirmation-time fallback. |
| Automated suite | All 60 tests passed across 6 files, including real MariaDB persistence/concurrency checks, fake transports, public endpoints and SSRF destination validation. No external mail was submitted. |
| Real migration CLI | `001_initial` applied successfully to isolated `email_crm_ui_test`. |
| Browser checks | All 8 checks passed: login, contact persistence/edit/notes/tasks/stage, settings persistence, templates and sample preview, campaign draft/personalization/exclusion, and navigation. All routes plus 1024px/390px layouts had no page overflow or observed runtime/API errors. This was not a full assistive-technology accessibility audit. |
| Local doctor | Passed supported engine, UTC clock, InnoDB, advisory locks, queue SQL and SMTP/IMAP certificate-verified TLS 1.3 reachability. An ephemeral DB diagnostic user was removed afterward. No mailbox authentication or email submission occurred. |
| Backup/restore rehearsal | MariaDB dump restored to an isolated schema; 29 tables and 54 rows were compared, with all row values equal. This was a fixture restore, not recovery of a live-mail incident. |
| Screenshots | `artifacts/crm-overview.png`, `artifacts/crm-prospects.png`, `artifacts/crm-mobile.png` were generated and visually reviewed. |

## Earlier release checks

- [x] Dependency installation and lockfile verified; production dependency audit had 0 reported advisories.
- [x] TypeScript checks and production build pass.
- [x] All 60 pure/fake-transport and MariaDB integration tests passed across 6 files with no external mail.
- [ ] Disposable MySQL 8 integration suite passes, including concurrency/cap/restart behavior.
- [x] Disposable local MariaDB 11.4.8 integration suite passes.
- [ ] Exact Hostinger database-version integration and account/runtime checks pass.
- [x] Browser walkthrough verifies the 8 recorded scenarios and responsive overflow checks.
- [ ] Complete manual accessibility and every primary-action acceptance scenario are signed off.
- [x] Local doctor reports expected environment, supported engine, clock, locking and TLS reachability.
- [ ] The same doctor evidence is collected inside the actual Hostinger Web App runtime.
- [ ] Private SMTP/IMAP authenticated validation passes; no connection-test email is sent.
- [ ] Actual scheduler mechanism/cadence/environment, bounded runtime, overlap, idle behavior and restarts verified.
- [x] Isolated database backup/restore succeeds with complete fixture row comparison.
- [ ] Controlled live-mail acceptance, if explicitly authorized, confirms actual mailbox behavior.

Unchecked items remain unverified even when corresponding source exists. The acceptance matrix in [testing.md](testing.md) intentionally remains a complete release checklist; a bundled item is not automatically checked because one corresponding unit test passed. Login-throttling exhaustion, real session expiry over time, all production proxy/cookie conditions, complete keyboard/screen-reader behavior, and every possible provider/restart failure have not been exhaustively demonstrated.

### Executed helper checks

The HTTP scheduler helper passed JavaScript syntax/help checks and a disposable loopback HTTP fixture: exactly one authenticated POST to `/internal/tick`, stdin token input, no token in output, no redirect following, refusal of non-loopback plain HTTP, and refusal of a short secret. These checks used a fake token and no real worker, SMTP, or IMAP server. The local doctor result above is point-in-time local evidence, not Hostinger evidence.

An independent Node 24.22.0 loopback SMTP fixture consumed the complete DATA payload and closed before its final response. Installed Nodemailer reported `ECONNECTION`/`CONN`; the application correctly classified that submission as unknown with automatic retry disabled. Local MIME fixtures through the installed mailparser also preserved structured report classification, paired separate 4.x/5.x recipient statuses, and treated a postmaster sender name alone as uncertain. These fixture messages never left the local fake service and did not contact a real mailbox.

## Direct Inbox mail verification

Inbox provides **New message** with a sending mailbox, recipient, subject, and message. Replies use the original external email address without requiring a prospect or manual contact match. New one-to-one messages may target an address with no CRM contact, and no contact or campaign opt-in is created implicitly. Suppression and revoked consent remain enforced at enqueue and submission. Campaigns and campaign tests retain their documented opt-in/test requirements. Manual Inbox mail uses the existing delivery queue, sending gate, pause, mailbox validation, sync freshness, hours, spacing, caps and unknown-outcome holds.

Queued manual recipients remain fixed independently of contact edits or incorrect legacy matches. Replies retain the original mailbox and message headers. Contactless threads group by mailbox and external address; referenced incoming replies are recognized without a contact record. Manual Inbox mail has no campaign tracking or marketing footer. The existing nullable schema supports the change without a migration.

The full isolated MariaDB 11.4.8 suite passed **100 tests across 7 files**, including 40 engine tests. Production build and TypeScript checks passed. The expanded browser walkthrough passed **11 checks**, with direct compose, contact-free reply and mobile composer checks added to prior acceptance. Desktop Inbox and mobile compose screenshots were visually reviewed. SMTP transports were fake; browser sending stayed disabled with no worker and zero send attempts. No real email was submitted and no Hostinger production verification was performed.

## Configurable API origins and authorized live-send setting

`ALLOWED_ORIGINS` supports the default APP_URL origin, additional exact HTTP(S) origins, or `*`. API preflights run before session/database work. Wildcard responses omit credential sharing; cookie sessions, CSRF tokens, permissions and scheduler authentication remain enforced. The local environment was updated to `ALLOWED_ORIGINS=*` and `LIVE_SEND_ENABLED=true` at the user's request. Existing app/worker processes require a restart; dashboard pauses, mailbox validation, recent sync, sending windows, capacity and recipient eligibility still apply.

The production build/typecheck and **113 tests across 8 files** passed, including 12 focused origin tests and the real-app CORS/session/CSRF/scheduler check. Tests used fake mail transports and a disposable MariaDB schema on loopback port 3308; that temporary server was stopped. No worker was run against the real CRM, no real email was submitted, and no Hostinger settings or deployment were changed.

## Next.js runtime migration

The current runtime uses Next.js 16.4.2 App Router, React 19/TypeScript, native dashboard URLs and Node Route Handlers. Next.js owns the development and production HTTP server; the domain routers now dispatch Web Requests through `server/http.ts`. The shared dashboard layout and components remain in `client/`. The Next.js proxy supplies CSP nonces and security headers; session, CSRF, API-origin and mail-safety rules remain enforced.

The schema, Knex/mysql2 database layer, encrypted mailbox data, scheduled jobs and worker are retained. No new data migration is required. `npm run build` builds `.next` and the compiled CLI tools in `dist`; the bounded worker entry remains `dist/scripts/worker.js`.

- [x] Next.js production build and both TypeScript checks pass; CLI tools compile into `dist`.
- [x] All **122 tests across 9 files** pass on Vitest 5.0.5, including 49 database-backed API/engine checks and 9 new native HTTP boundary checks.
- [x] All **14 browser checks** pass against actual `next start`, including direct URLs, contact persistence, compose/reply, CSP nonces, Secure/HttpOnly/SameSite cookies, CSV authorization, tracking and unsubscribe behavior, legacy bookmarks and mobile layouts.
- [x] `npm install` / audit reports **0 vulnerabilities**, including development dependencies, after the patched test-runner upgrade.

These checks used Node 24.22.0, the separate loopback MariaDB 11.4.8 on port 3308, fake transports, and private generated browser fixtures with live sending disabled and no worker. Desktop and mobile screenshots were inspected. The browser fixture exercises production HTTPS configuration and Secure cookies using Chromium's trustworthy loopback behavior; it does not prove a public TLS deployment. No real CRM data, mailbox credentials or encryption keys were changed. The local dashboard URL was moved from port 5173 to port 3000, retaining other environment settings. No deployment, DNS change or live-mail submission is part of the framework migration.

## Hostinger production-mode build fix

The reported `/_global-error` prerender exception (`Cannot read properties of null (reading 'use')`) was reproduced locally by exporting `NODE_ENV=development` before the build. The installed dependency tree already contained a single deduplicated React/React DOM 19.3.1 pair. Their versions are now pinned exactly, together with the existing React 19.3.0 type packages, while preserving the tested lockfile.

`scripts/next.mjs` sets the correct mode before loading Next/React: production for build/start and development for dev. It loads the CLI in the same process, preserving ordinary signals and process lifecycle. `app/global-error.tsx` supplies a standalone client fallback with its own HTML/body and no layout/provider dependencies or raw error details. Hostinger must also set `NODE_ENV=production` for any platform-controlled commands that bypass npm scripts.

A clean build with the same inherited `NODE_ENV=development` now succeeds, including prerendering and CLI-tool compilation. All **14 browser checks** pass with production startup deliberately given that development value, including Secure/HttpOnly/SameSite cookies and the normal CRM/Inbox flows. Dependency audit remains at **0 vulnerabilities**. Checks used isolated loopback fixtures, disabled live sending and no mail worker; no real database or private environment settings were changed. Actual Hostinger redeployment remains a separate verification step.

## Deliberately deferred

- OAuth mailbox providers; the transport boundary supports a later adapter, but no working OAuth sign-in/refresh implementation is represented.
- Attachments, attachment storage/download, and full mailbox/folder management. Large attachment bodies are not stored in MySQL.
- Public signup, SaaS billing, multi-tenant isolation, account rotation and provider-limit bypasses.
- Automatic provider storage/quota introspection and complete accounting for messages sent through webmail/other clients.
- Guaranteed inbox delivery, exactly-once delivery, instantaneous reply detection, and reliable identification of every tracking scanner; SMTP/IMAP cannot provide those guarantees.
- Automatic suppression reactivation. The dashboard offers no unsuppress API; imports cannot erase a prior opt-out.
- General contact/message/audit erasure and automatic backup scheduling. The worker implements retention for raw open/click events only; protected safety/history records are retained. Verify actual periodic execution before relying on cleanup.

## Known verification boundaries

No deployment, DNS edits or live messages are part of this local implementation. The actual Hostinger engine/version, Node binary and build paths, cron access, app timeouts/idle behavior, outbound mail reachability, authenticated mailbox access, and real provider allowance must be checked in the owner's environment. The docs include executable diagnostics and procedures, but do not claim those private account checks were performed.

The UI and API scope should be compared with the complete acceptance matrix before release. If any requested control is absent or a supplied test is skipped, record that specific gap here and in the delivery report rather than labeling the entire application complete.
