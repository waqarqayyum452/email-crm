# Email CRM

Local-only implementation for San Diego Website Experts. Do not deploy, change DNS, or send live mail without explicit authorization.

Stack: Next.js App Router with React 19/TypeScript and Node Route Handlers; TypeScript modular monolith; Knex + mysql2 with MySQL 8+; Nodemailer, ImapFlow, mailparser; Vitest. UTC database timestamps. No public signup, no demo analytics, no Redis.

Read docs/contracts.md before implementing cross-module APIs. Keep mailbox credentials encrypted and out of API responses/logs. Enforce suppression and consent at actual send time. Unknown SMTP acceptance must never be automatically retried. All state-changing dashboard requests require a session and CSRF token.
