import { chromium, expect } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer as createPortProbe } from 'node:net';
import mysql from 'mysql2/promise';

// Run only against an explicitly isolated local database. Never uses a mailbox connection.
const database = process.env.DB_NAME || 'email_crm_ui_test';
if (!/^[a-zA-Z0-9_]+_ui_test$/.test(database)) throw new Error('Browser checks require DB_NAME ending in _ui_test.');
if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST || '127.0.0.1')) throw new Error('Browser checks require a loopback database host.');
// Exercise the production runtime and Secure cookies on trustworthy loopback.
// APP_URL advertises HTTPS for production validation; this local-only fixture
// explicitly allows its HTTP browser origin and never runs a mail worker.
Object.assign(process.env, {
  DB_HOST: process.env.DB_HOST || '127.0.0.1', DB_PORT: process.env.DB_PORT || '3306', DB_USER: process.env.DB_USER || 'root', DB_PASSWORD: process.env.DB_PASSWORD || '',
  DB_NAME: database, NODE_ENV: 'production', PORT: '3100', APP_URL: 'https://127.0.0.1:3100', ALLOWED_ORIGINS: 'http://127.0.0.1:3100',
  __NEXT_PROCESSED_ENV: 'true',
  LIVE_SEND_ENABLED: 'false', ENCRYPTION_KEY: randomBytes(32).toString('base64'), SCHEDULER_SECRET: randomBytes(32).toString('hex'),
});
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(projectRoot, 'artifacts');
const runId = randomBytes(5).toString('hex');
const ownerEmail = `owner-${runId}@example.test`, contactEmail = `jamie-${runId}@example.test`;
const password = randomBytes(26).toString('base64url');
let server, browser, db, page;
const failures = [];
const checks = [];
const apiTrail = [];
let serverOutput = '';
const startupDiagnostic = value => String(value)
  .replace(/\b(password|secret|token|authorization)\s*[:=]\s*["']?[^\s,"'}]+/gi, '$1=[REDACTED]')
  .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
  .replace(/[\r\n\t]+/g, ' ').slice(-1500);

async function startNextServer() {
  // Never mistake a preexisting app on this port for the isolated child server.
  const probe = createPortProbe();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(3100, '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => { probe.close(error => error ? reject(error) : resolve()); });
  // Regress the Hostinger configuration: the launcher must enforce production
  // even when the panel exported a development environment before startup.
  const child = spawn(process.execPath, [path.join(projectRoot, 'scripts/next.mjs'), 'start', '--hostname', '127.0.0.1', '--port', '3100'], {
    cwd: projectRoot, env: { ...process.env, NODE_ENV: 'development' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server = child;
  child.stdout.on('data', chunk => { serverOutput = (serverOutput + chunk).slice(-8000); });
  child.stderr.on('data', chunk => { serverOutput = (serverOutput + chunk).slice(-8000); });
  let startupError;
  child.once('error', error => { startupError = error; });
  const deadline = Date.now() + 30000;
  let readiness = 'No readiness response received.';
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw new Error(`Next server exited during startup (${child.exitCode}). ${startupDiagnostic(serverOutput)}`);
    try {
      const response = await fetch('http://127.0.0.1:3100/healthz', { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
      readiness = `HTTP ${response.status}: ${startupDiagnostic((await response.text()).slice(0, 1000))}`;
    } catch (error) { readiness = startupDiagnostic(`${error.name}: ${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`); }
    await delay(150);
  }
  throw new Error(`Next server did not become ready within 30 seconds. Last readiness result: ${readiness}. ${startupDiagnostic(serverOutput)}`);
}

async function stopNextServer() {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, 'exit');
  server.kill();
  if (await Promise.race([exited.then(() => true), delay(3000).then(() => false)])) return;
  server.kill('SIGKILL');
  await exited;
}

async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`); }
async function mutate(page, method, apiPath, action) {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === `/api${apiPath}`, { timeout: 15000 }).catch(() => { throw new Error(`Timed out waiting for ${method} /api${apiPath}`); }),
    action(),
  ]);
  if (!response.ok()) throw new Error(`${method} ${apiPath}: ${response.status()} ${await response.text()}`);
  return response.json();
}
async function noPageOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  expect(overflow, `${label} must fit the viewport; tables/boards scroll within their panels`).toBe(false);
}

try {
  await mkdir(artifacts, { recursive: true });
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '',
  });
  try { await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); } finally { await connection.end(); }
  ({ db } = await import('../dist/server/db.js'));
  const migrationDirectory = path.join(projectRoot, 'dist/server/migrations');
  const migrationSource = {
    async getMigrations() { return (await readdir(migrationDirectory)).filter(name => /^\d+.*\.js$/.test(name)).sort(); },
    getMigrationName(name) { return name.replace(/\.js$/, ''); },
    async getMigration(name) { return import(pathToFileURL(path.join(migrationDirectory, name)).href); },
  };
  await db.migrate.latest({ migrationSource });
  const { hashPassword } = await import('../dist/server/lib/crypto.js');
  const ownerId = randomUUID(), mailboxId = randomUUID(), composeMailboxId = randomUUID(), inboundMessageId = randomUUID(), now = new Date();
  const inboxSender = `inbox-sender-${runId}@example.test`;
  await db('users').insert({ id: ownerId, name: 'Browser QA Owner', email: ownerEmail, password_hash: await hashPassword(password), role: 'owner', permissions: '[]', disabled: false, created_at: now, updated_at: now });
  await db('email_accounts').insert({
    id: mailboxId, label: 'Local test mailbox', email: `mailbox-${runId}@example.test`, sender_name: 'Browser QA',
    smtp_host: 'smtp.example.test', smtp_port: 465, smtp_security: 'tls', smtp_username: 'local-test',
    imap_host: 'imap.example.test', imap_port: 993, imap_security: 'tls', imap_username: 'local-test',
    status: 'inactive', provider_policy: 'opt_in_only', is_default: false, created_at: now, updated_at: now,
  });
  await db('email_accounts').insert({
    id: composeMailboxId, label: 'Normal inbox test mailbox', email: `normal-inbox-${runId}@example.test`, sender_name: 'Browser QA',
    smtp_host: 'smtp.example.test', smtp_port: 465, smtp_security: 'tls', smtp_username: 'local-test',
    imap_host: 'imap.example.test', imap_port: 993, imap_security: 'tls', imap_username: 'local-test',
    status: 'active', provider_policy: 'opt_in_only', is_default: true, verified_at: now, last_sync_at: now, created_at: now, updated_at: now,
  });
  await db('messages').insert({
    id: inboundMessageId, account_id: composeMailboxId, contact_id: null, direction: 'inbound',
    message_id: `<contactless-${runId}@example.test>`, references_json: '[]', from_email: inboxSender,
    to_email: `normal-inbox-${runId}@example.test`, subject: `Contactless inbox QA ${runId}`, body_text: 'A normal email does not require a CRM contact.',
    classification: 'unmatched', is_test: false, received_at: now, created_at: now,
  });
  const { encryptSecret } = await import('../dist/server/lib/crypto.js');
  const receivedFile = { id: randomUUID(), filename: 'conversation.pdf', content_type: 'application/pdf', size: 16, encrypted_content: encryptSecret(Buffer.from('%PDF browser QA').toString('base64')) };
  const { encrypted_content: omittedFileContent, ...receivedManifest } = receivedFile;
  await db('message_details').insert({ message_id: inboundMessageId, from_name: 'Jamie Inbox', to_name: 'Browser QA', attachments: JSON.stringify([receivedFile]), attachment_manifest: JSON.stringify([receivedManifest]), created_at: now });
  const publicMessageId = randomUUID(), publicRecipient = `optout-${runId}@example.test`;
  const openToken = randomBytes(32).toString('hex'), unsubscribeToken = randomBytes(32).toString('hex'), clickToken = randomBytes(32).toString('hex');
  await db('messages').insert({
    id: publicMessageId, account_id: composeMailboxId, contact_id: null, direction: 'outbound',
    message_id: `<public-routes-${runId}@example.test>`, references_json: '[]', from_email: `normal-inbox-${runId}@example.test`,
    to_email: publicRecipient, subject: 'Public route fixture only', body_text: 'Never submitted to SMTP.', classification: 'outbound', is_test: false, received_at: now, created_at: now,
  });
  await db('tracking_tokens').insert([
    { id: openToken, message_id: publicMessageId, contact_id: null, kind: 'tracking', created_at: now },
    { id: unsubscribeToken, message_id: publicMessageId, contact_id: null, kind: 'unsubscribe', created_at: now },
  ]);
  await db('tracked_links').insert({ id: randomUUID(), token: clickToken, message_id: publicMessageId, url: 'https://example.test/review', created_at: now });
  await startNextServer();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on('pageerror', error => failures.push(error.message));
  page.on('response', response => { const pathname = new URL(response.url()).pathname; if (pathname.startsWith('/api/')) apiTrail.push(`${response.request().method()} ${pathname}: ${response.status()}`); });
  const initialDocument = await page.goto('http://127.0.0.1:3100', { waitUntil: 'networkidle' });
  await check('Next pages use per-request CSP nonces and API/public routes preserve their response contracts', async () => {
    const headers = initialDocument.headers(), csp = headers['content-security-policy'] || '', nonce = csp.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce, 'Next document CSP includes a script nonce').toBeTruthy();
    expect(await page.locator('script').evaluateAll(scripts => scripts.map(script => script.nonce).filter(Boolean))).toContain(nonce);
    expect(headers['x-content-type-options']).toBe('nosniff'); expect(headers['x-powered-by']).toBeUndefined();
    const secondDocument = await page.request.get('http://127.0.0.1:3100/overview');
    expect(secondDocument.headers()['content-security-policy']).toContain("'nonce-");
    expect(secondDocument.headers()['content-security-policy']).not.toContain(`'nonce-${nonce}'`);
    const session = await fetch('http://127.0.0.1:3100/api/auth/session');
    expect(session.status).toBe(200); expect(session.headers.get('cache-control')).toContain('no-store');
    expect((await fetch('http://127.0.0.1:3100/api/analytics/export.csv')).status).toBe(401);
    expect((await fetch('http://127.0.0.1:3100/internal/tick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    const template = await fetch('http://127.0.0.1:3100/import-template.csv');
    expect(template.status).toBe(200); expect(await template.text()).toContain('email');
  });
  await check('Next public tracking and unsubscribe endpoints work without sign-in and preserve confirmation semantics', async () => {
    const pixel = await fetch(`http://127.0.0.1:3100/t/open/${openToken}.gif`);
    expect(pixel.status).toBe(200); expect(pixel.headers.get('content-type')).toContain('image/gif');
    expect(Buffer.from(await pixel.arrayBuffer()).subarray(0, 3).toString()).toBe('GIF');
    expect(await db('tracking_events').where({ message_id: publicMessageId, kind: 'open' })).toHaveLength(1);
    const click = await fetch(`http://127.0.0.1:3100/t/click/${clickToken}?url=https://ignored.example.test`, { redirect: 'manual' });
    expect(click.status).toBe(302); expect(click.headers.get('location')).toBe('https://example.test/review');
    const url = `http://127.0.0.1:3100/unsubscribe/${unsubscribeToken}`;
    const confirmation = await fetch(url); expect(confirmation.status).toBe(200); expect(await confirmation.text()).toContain('Confirm unsubscribe');
    expect(await db('suppressions').where({ email: publicRecipient })).toHaveLength(0);
    const result = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ unsubscribed: true });
    expect(await db('suppressions').where({ email: publicRecipient })).toHaveLength(1);
    expect(await db('contacts').where({ email: publicRecipient })).toHaveLength(0);
    expect(await db('send_attempts')).toHaveLength(0);
  });
  await check('Owner signs in with session and CSRF', async () => {
    const logo=page.locator('.login-brand .brand-wordmark');
    await expect(logo).toHaveAttribute('src','/sdwe-wordmark.webp');
    expect(await logo.evaluate(node=>node.complete&&node.naturalWidth>0)).toBe(true);
    expect(await page.locator('.login-story').evaluate(node=>getComputedStyle(node).backgroundColor)).toBe('rgb(206, 235, 255)');
    expect(await page.locator('.login-form button[type=submit]').evaluate(node=>getComputedStyle(node).backgroundColor)).toBe('rgb(56, 99, 255)');
    await page.setViewportSize({width:390,height:844});
    await noPageOverflow(page,'Branded mobile login');
    await page.screenshot({path:path.join(artifacts,'crm-brand-login-mobile.png'),fullPage:true});
    await page.setViewportSize({width:1440,height:1100});
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(artifacts, 'crm-login-modern.png'), fullPage: true });
    await page.getByLabel('Email address', { exact: true }).fill(ownerEmail);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await mutate(page, 'POST', '/auth/login', () => page.getByRole('button', { name: 'Sign in to workspace' }).click());
    const sessionCookie = (await page.context().cookies()).find(cookie => cookie.name === 'sdwe_session');
    expect(sessionCookie, 'Production login creates a session cookie').toBeTruthy();
    expect(sessionCookie.secure).toBe(true); expect(sessionCookie.httpOnly).toBe(true); expect(sessionCookie.sameSite).toBe('Strict');
    await expect(page.getByRole('heading', { name: 'Good to see you, Browser.' })).toBeVisible();
    await expect(page.locator('.sidebar .brand-wordmark')).toBeVisible();
    expect(await page.locator('.sidebar').evaluate(node=>getComputedStyle(node).backgroundColor)).toBe('rgb(222, 240, 253)');
    await expect(page.getByText('Automation paused', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Outreach performance', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sending capacity', exact: true })).toBeVisible();
    await expect(page.locator('.metrics-grid .metric-value')).toHaveCount(8);
    await expect(page.locator('.loading')).toHaveCount(0);
    await page.screenshot({ path: path.join(artifacts, 'crm-overview.png'), fullPage: true });
    await noPageOverflow(page, 'Desktop overview');
  });
  await check('Authenticated Next CSV downloads and legacy hash links preserve access and navigation', async () => {
    const exported = await page.request.get('http://127.0.0.1:3100/api/analytics/export.csv');
    expect(exported.status()).toBe(200); expect(exported.headers()['content-type']).toContain('text/csv');
    expect(exported.headers()['content-disposition']).toContain('attachment; filename="analytics.csv"');
    expect(await exported.text()).toContain('smtp_accepted_messages');
    await page.goto('http://127.0.0.1:3100/#inbox', { waitUntil: 'networkidle' });
    await page.waitForURL('http://127.0.0.1:3100/inbox');
    await expect(page.getByRole('heading', { level: 1, name: 'Inbox', exact: true })).toBeVisible();
  });
  let contactId;
  await check('Contact creation persists through page reload', async () => {
    await page.goto('http://127.0.0.1:3100/prospects');
    await page.getByRole('button', { name: 'Add prospect', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a prospect' });
    await dialog.getByLabel('First name').fill('Jamie');
    await dialog.getByLabel('Last name').fill('Rivera');
    await dialog.getByLabel('Email address', { exact: true }).fill(contactEmail);
    await dialog.getByLabel('Company', { exact: true }).fill('Browser QA Coastal Studio');
    await dialog.getByLabel('Contact source', { exact: true }).fill('Isolated browser acceptance check');
    await dialog.getByLabel('Consent status').selectOption('test');
    await dialog.getByLabel('Consent evidence').fill('Isolated example.test fixture; live sending is disabled.');
    const contact = await mutate(page, 'POST', '/contacts', () => dialog.getByRole('button', { name: 'Add contact', exact: true }).click());
    contactId = contact.id;
    await expect(dialog).not.toBeVisible();
    await page.reload();
    await expect(page.getByText(contactEmail, { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'crm-prospects.png'), fullPage: true });
  });
  await check('Contact edit, notes, tasks, and stage changes persist', async () => {
    await page.goto(`http://127.0.0.1:3100/prospects/${contactId}`);
    await page.getByRole('button', { name: 'Edit contact', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit contact' });
    await dialog.getByLabel('City', { exact: true }).fill('San Diego');
    // Exercise an explicit consent change. This contact must later be excluded
    // from sending while still being usable for a harmless content preview.
    await dialog.getByLabel('Consent status', { exact: true }).selectOption('unknown');
    await mutate(page, 'PATCH', `/contacts/${contactId}`, () => dialog.getByRole('button', { name: 'Save contact' }).click());
    await expect(dialog).not.toBeVisible();
    await page.getByRole('textbox', { name: 'New contact note' }).fill('Browser QA: follow up on their website project.');
    await mutate(page, 'POST', `/contacts/${contactId}/notes`, () => page.getByRole('button', { name: 'Add note', exact: true }).click());
    await expect(page.getByText('Browser QA: follow up on their website project.', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Task title' }).fill('Browser QA: schedule discovery call');
    await mutate(page, 'POST', `/contacts/${contactId}/tasks`, () => page.getByRole('button', { name: 'Add', exact: true }).click());
    await expect(page.getByText('Browser QA: schedule discovery call', { exact: true })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.loading')).toHaveCount(0);
    const stageSelect = page.getByLabel('Pipeline stage', { exact: true });
    const qualified = await db('pipeline_stages').where({ name: 'Qualified' }).first();
    await expect(stageSelect).toBeEnabled();
    await stageSelect.scrollIntoViewIfNeeded();
    await mutate(page, 'PATCH', `/contacts/${contactId}`, () => stageSelect.selectOption(qualified.id));
    await page.reload();
    await expect(page.getByLabel('Pipeline stage', { exact: true })).toHaveValue((await db('pipeline_stages').where({ name: 'Qualified' }).first()).id);
    await expect(page.getByText('Browser QA: follow up on their website project.', { exact: true })).toBeVisible();
    expect((await db('contacts').where({ id: contactId }).first()).city).toBe('San Diego');
  });
  await check('Owner business settings save', async () => {
    await page.goto('http://127.0.0.1:3100/settings/business');
    await page.getByLabel('Business address', { exact: true }).fill('Browser QA · isolated local test database');
    await mutate(page, 'PATCH', '/settings', () => page.getByRole('button', { name: 'Save changes' }).click());
    await page.reload();
    await expect(page.getByLabel('Business address', { exact: true })).toHaveValue('Browser QA · isolated local test database');
  });
  await check('Templates save, duplicate, and preview with sample data', async () => {
    await page.goto('http://127.0.0.1:3100/templates');
    await page.getByRole('button', { name: 'Create template', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create a template' });
    await dialog.getByLabel('Template name', { exact: true }).fill(`Browser QA welcome ${runId}`);
    await dialog.getByLabel('Subject', { exact: true }).fill('Hello {{first_name|there}}');
    await dialog.getByLabel('Plain-text body', { exact: true }).fill('Hello {{first_name|there}}, this is an isolated local test.');
    await dialog.getByRole('button', { name: 'Preview with sample data' }).click();
    await expect(dialog.getByText('Hello Jamie', { exact: true })).toBeVisible();
    const template = await mutate(page, 'POST', '/templates', () => dialog.getByRole('button', { name: 'Save template', exact: true }).click());
    await expect(dialog).not.toBeVisible();
    await mutate(page, 'POST', `/templates/${template.id}/duplicate`, () => page.getByRole('button', { name: `Duplicate Browser QA welcome ${runId}`, exact: true }).click());
    await expect(page.getByRole('heading', { name: `Browser QA welcome ${runId} (copy)`, exact: true })).toBeVisible();
  });
  await check('Campaign draft, personalization preview, and safe exclusions', async () => {
    await page.goto('http://127.0.0.1:3100/campaigns');
    await page.getByRole('button', { name: 'Create campaign', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create a campaign' });
    await dialog.getByLabel('Campaign name', { exact: true }).fill(`Browser QA sequence ${runId}`);
    await dialog.getByLabel('Sending mailbox', { exact: true }).selectOption(mailboxId);
    await dialog.getByLabel('Subject', { exact: true }).fill('Hello {{first_name|there}}');
    await dialog.getByLabel('Plain-text message', { exact: true }).fill('Hello {{first_name|there}}, checking in with {{company_name}}.');
    await dialog.getByRole('button', { name: '2. Choose audience (0)', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Search campaign audience' }).fill(contactEmail);
    const audience = dialog.locator('.audience-list label').filter({ hasText: contactEmail });
    await audience.getByRole('checkbox').check();
    const campaign = await mutate(page, 'POST', '/campaigns', () => dialog.getByRole('button', { name: 'Save draft & review', exact: true }).click());
    const detail = page.getByRole('dialog', { name: `Browser QA sequence ${runId}` });
    await expect(detail).toBeVisible();
    await expect(detail.getByText('1 exclusions', { exact: true })).toBeVisible();
    // An explicit contact permits content preview while the inactive mailbox remains excluded from launch.
    await detail.getByRole('combobox', { name: 'Preview contact' }).selectOption(contactId);
    const preview = await mutate(page, 'POST', `/campaigns/${campaign.id}/preview`, () => detail.getByRole('button', { name: 'Preview', exact: true }).click());
    expect(preview.steps[0].subject).toBe('Hello Jamie');
    await expect(detail.getByText('Hello Jamie', { exact: true })).toBeVisible();
    expect(await db('send_attempts').count({ total: '*' }).first()).toMatchObject({ total: 0 });
    await detail.getByRole('button', { name: 'Close dialog' }).click();
  });
  await check('Normal Inbox composes to a new address without creating a contact or submitting mail', async () => {
    const recipient = `new-inbox-person-${runId}@example.test`;
    await page.goto('http://127.0.0.1:3100/inbox', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New message', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New message', exact: true });
    // Opening from All mailboxes must select the real default, not just display it.
    await expect(dialog.getByLabel('From mailbox', { exact: true })).toHaveValue(composeMailboxId);
    await expect(dialog.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('status')).toHaveText('Enter the recipient’s email address.');
    await dialog.getByLabel('To email', { exact: true }).fill('invalid');
    await expect(dialog.getByRole('status')).toHaveText('Enter a valid recipient email address.');
    await dialog.getByLabel('To email', { exact: true }).fill(recipient);
    await expect(dialog.getByRole('status')).toHaveText('Add a subject.');
    await dialog.getByLabel('Subject', { exact: true }).fill('Browser QA personal message');
    await expect(dialog.getByRole('status')).toHaveText('Write a message before sending.');
    await dialog.getByLabel('Message', { exact: true }).fill('An isolated normal email queued while live sending is disabled.');
    await expect(dialog.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await expect(dialog.getByRole('status')).toHaveCount(0);
    const processed = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/inbox/process');
    const queued = await mutate(page, 'POST', '/inbox/compose', () => dialog.getByRole('button', { name: 'Send message', exact: true }).click());
    await expect(dialog).not.toBeVisible();
    expect((await processed).status()).toBe(200);
    const job = await db('jobs').where({ id: queued.job_id }).first();
    const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
    expect(payload).toMatchObject({ is_manual: true, manual_recipient: recipient, contact_id: null });
    expect(job.account_id).toBe(composeMailboxId); expect(job.status).toBe('queued');
    expect(await db('contacts').where({ email: recipient })).toHaveLength(0);
    expect(await db('send_attempts')).toHaveLength(0);
    const outbox = page.getByRole('region', { name: 'Outbox', exact: true });
    await expect(outbox.locator('.outbox-items')).toBeHidden();
    await outbox.locator('summary').click();
    await expect(outbox.locator('.conversation-item').filter({ hasText: recipient }).getByRole('heading', { name: 'Browser QA personal message', exact: true })).toBeVisible();
    await outbox.locator('summary').click();
    await expect(outbox.locator('.outbox-items')).toBeHidden();
  });
  await check('Normal Inbox replies to an unmatched sender without a contact matching flow', async () => {
    await page.goto(`http://127.0.0.1:3100/inbox/${inboundMessageId}`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('button', { name: /match.*contact/i })).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Reply message', exact: true }).fill('A normal contactless reply, queued only.');
    await expect(page.getByRole('button', { name: 'Send reply', exact: true })).toBeEnabled();
    const processed = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/inbox/process');
    const queued = await mutate(page, 'POST', `/inbox/${inboundMessageId}/reply`, () => page.getByRole('button', { name: 'Send reply', exact: true }).click());
    expect((await processed).status()).toBe(200);
    const job = await db('jobs').where({ id: queued.job_id }).first();
    const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
    expect(payload).toMatchObject({ is_manual: true, is_reply: true, manual_recipient: inboxSender, reply_source_id: inboundMessageId });
    expect((await db('messages').where({ id: inboundMessageId }).first()).contact_id).toBeNull();
    expect(await db('contacts').where({ email: inboxSender })).toHaveLength(0);
    expect(await db('send_attempts')).toHaveLength(0);
    await page.screenshot({ path: path.join(artifacts, 'crm-inbox-contactless.png'), fullPage: true });
  });
  await check('Email composer formats content, saves an attachment draft, resumes it and queues a signature with tracking', async () => {
    await page.goto('http://127.0.0.1:3100/inbox', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New message', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'New message', exact: true });
    await dialog.getByLabel('From mailbox', { exact: true }).selectOption(composeMailboxId);
    await dialog.getByLabel('To email', { exact: true }).fill(`draft-person-${runId}@example.test`);
    await dialog.getByLabel('Subject', { exact: true }).fill(`Formatted proposal ${runId}`);
    const editor = dialog.getByRole('textbox', { name: 'Message', exact: true });
    await editor.fill('Hello from the formatted composer.');
    await editor.selectText();
    await editor.evaluate(node => { const selected = window.getSelection(), range = document.createRange(); range.selectNodeContents(node); selected.removeAllRanges(); selected.addRange(range); node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
    await dialog.getByRole('button', { name: 'Bold', exact: true }).click();
    await expect(editor.locator('strong')).toHaveText('Hello from the formatted composer.');
    await dialog.getByRole('button', { name: 'Bold', exact: true }).click();
    await expect(editor.locator('strong')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Bold', exact: true }).click();
    await expect(editor.locator('strong')).toHaveText('Hello from the formatted composer.');
    await dialog.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'proposal.txt', mimeType: 'text/plain', buffer: Buffer.from('Private isolated browser document.') });
    await expect(dialog.getByText('proposal.txt', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: 'Track opens', exact: true })).toBeChecked();
    await dialog.getByRole('button', { name: 'Edit signature', exact: true }).click();
    await dialog.getByLabel('Email signature', { exact: true }).fill('Jamie at the agency');
    const saved = await mutate(page, 'POST', '/inbox/drafts', () => dialog.getByRole('button', { name: 'Save draft & close', exact: true }).click());
    await expect(dialog).not.toBeVisible();
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^Drafts/ }).click();
    await page.getByRole('button').filter({ hasText: `Formatted proposal ${runId}` }).click();
    dialog = page.getByRole('dialog', { name: 'New message', exact: true });
    await expect(dialog.getByRole('textbox', { name: 'Message', exact: true })).toHaveText('Hello from the formatted composer.');
    await expect(dialog.getByText('proposal.txt', { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'crm-mail-composer-desktop.png'), fullPage: true });
    const queued = await mutate(page, 'POST', '/inbox/compose', () => dialog.getByRole('button', { name: 'Send message', exact: true }).click());
    const job = await db('jobs').where({ id: queued.job_id }).first();
    const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
    expect(payload).toMatchObject({ open_tracking: true, content: { body_html: expect.stringContaining('<strong>'), body_text: expect.stringContaining('Jamie at the agency') }, attachments: [{ filename: 'proposal.txt' }] });
    expect(JSON.stringify(job.payload)).not.toContain('Private isolated browser document.');
    expect(await db('mail_drafts').where({ id: saved.id })).toHaveLength(0);
    expect(await db('send_attempts')).toHaveLength(0);
  });
  await check('Sender profile, attachment download, Forward and expanded Reply use the original email context', async () => {
    await page.goto(`http://127.0.0.1:3100/inbox/${inboundMessageId}`, { waitUntil: 'networkidle' });
    const profile = page.locator('.mail-person').first();
    await expect(profile.locator('summary strong')).toHaveText('Jamie Inbox');
    await profile.locator('summary').click();
    await expect(profile.locator('.mail-person-card')).toContainText(inboxSender);
    await profile.locator('summary').click();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('link', { name: /conversation\.pdf/ }).click();
    expect((await downloaded).suggestedFilename()).toBe('conversation.pdf');
    await page.getByRole('button', { name: `Forward Contactless inbox QA ${runId}`, exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Forward message', exact: true });
    await expect(dialog.getByLabel('Subject', { exact: true })).toHaveValue(`Fwd: Contactless inbox QA ${runId}`);
    await expect(dialog.getByText('conversation.pdf', { exact: true })).toBeVisible();
    await dialog.getByLabel('To email', { exact: true }).fill(`forward-${runId}@example.test`);
    const forwarded = await mutate(page, 'POST', '/inbox/compose', () => dialog.getByRole('button', { name: 'Send message', exact: true }).click());
    let queuedJob = await db('jobs').where({ id: forwarded.job_id }).first();
    let payload = typeof queuedJob.payload === 'string' ? JSON.parse(queuedJob.payload) : queuedJob.payload;
    expect(payload.is_reply).toBeUndefined();expect(payload.in_reply_to).toBeUndefined();expect(payload.attachments).toHaveLength(1);
    await page.getByRole('button', { name: 'Reply to Jamie Inbox', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Reply message', exact: true })).toBeFocused();
    await page.getByRole('textbox', { name: 'Reply message', exact: true }).fill('An expanded reply keeps the original message anchor.');
    await page.getByRole('button', { name: 'Expand reply with formatting and attachments', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Reply to email', exact: true });
    await expect(dialog.getByLabel('To email', { exact: true })).toHaveValue(inboxSender);
    await expect(dialog.getByLabel('To email', { exact: true })).toHaveAttribute('readonly', '');
    await expect(dialog.getByRole('textbox', { name: 'Message', exact: true })).toHaveText('An expanded reply keeps the original message anchor.');
    const replied = await mutate(page, 'POST', `/inbox/${inboundMessageId}/reply`, () => dialog.getByRole('button', { name: 'Send message', exact: true }).click());
    queuedJob = await db('jobs').where({ id: replied.job_id }).first();payload = typeof queuedJob.payload === 'string' ? JSON.parse(queuedJob.payload) : queuedJob.payload;
    expect(payload).toMatchObject({ is_reply: true, reply_source_id: inboundMessageId, manual_recipient: inboxSender });
    await page.screenshot({ path: path.join(artifacts, 'crm-mail-profile-and-reply.png'), fullPage: true });
    expect(await db('send_attempts')).toHaveLength(0);
  });
  await check('Inbox refreshes incoming mail, preserves drafts through failures, and pauses hidden polling without overlap', async () => {
    await page.goto(`http://127.0.0.1:3100/inbox/${inboundMessageId}`, { waitUntil: 'networkidle' });
    const draft = page.getByRole('textbox', { name: 'Reply message', exact: true });
    await draft.fill('An unfinished reply must survive automatic updates.');
    const incomingId = randomUUID(), receivedAt = new Date();
    await db('messages').insert({
      id: incomingId, account_id: composeMailboxId, contact_id: null, direction: 'inbound',
      message_id: `<live-inbox-${runId}@example.test>`, in_reply_to: `<contactless-${runId}@example.test>`, references_json: JSON.stringify([`<contactless-${runId}@example.test>`]), from_email: inboxSender,
      to_email: `normal-inbox-${runId}@example.test`, subject: `Automatic inbox update ${runId}`,
      body_text: `New incoming message ${runId}`, classification: 'unmatched', is_test: false, received_at: receivedAt, created_at: receivedAt,
    });
    await expect(page.locator('.conversation-list .conversation-item').filter({ hasText: `New incoming message ${runId}` })).toHaveCount(1, { timeout: 16000 });
    await expect(page.locator('.conversation-list .conversation-item').filter({ hasText: `Contactless inbox QA ${runId}` })).toHaveCount(1);
    await expect(page.locator('.conversation-count').filter({ hasText: '2' })).toBeVisible();
    await expect(page.locator('.thread-messages').getByText(`New incoming message ${runId}`, { exact: true })).toBeVisible({ timeout: 16000 });
    await expect(draft).toHaveValue('An unfinished reply must survive automatic updates.');

    const detailPath = `/api/inbox/${inboundMessageId}`;
    const detailUrl = `http://127.0.0.1:3100${detailPath}`;
    const failRefresh = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary browser fixture outage.' }) });
    await page.route(detailUrl, failRefresh);
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === detailPath && response.status() === 503),
      page.evaluate(() => window.dispatchEvent(new Event('focus'))),
    ]);
    await expect(page.getByText('This conversation could not refresh. Retrying automatically; your reply draft is kept.', { exact: true })).toBeVisible();
    await expect(draft).toHaveValue('An unfinished reply must survive automatic updates.');
    await expect(page.locator('.thread-messages').getByText(`New incoming message ${runId}`, { exact: true })).toBeVisible();
    await page.unroute(detailUrl, failRefresh);
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === detailPath && response.ok()),
      page.evaluate(() => window.dispatchEvent(new Event('online'))),
    ]);

    let requests = 0, release;
    const blocked = new Promise(resolve => { release = resolve; });
    let hold = false;
    const countRefresh = async route => { requests++; if (hold) await blocked; await route.continue(); };
    await page.route(detailUrl, countRefresh);
    try {
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
      const beforeHidden = requests;
      await delay(10500);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      expect(requests, 'A hidden Inbox does not poll or refresh on focus').toBe(beforeHidden);
      hold = true;
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
      await expect.poll(() => requests).toBe(beforeHidden + 1);
      await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus')); });
      await delay(200);
      expect(requests, 'Focus/online events share the in-flight request').toBe(beforeHidden + 1);
      await expect(draft).toHaveValue('An unfinished reply must survive automatic updates.');
      const resumed = page.waitForResponse(response => new URL(response.url()).pathname === detailPath && response.ok());
      release();
      await resumed;
    } finally {
      release();
      await page.unroute(detailUrl, countRefresh);
      await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    }
    expect(await db('send_attempts')).toHaveLength(0);
  });
  await check('Inbox keeps Outbox fixed, scrolls both panes independently, and separates a new subject', async () => {
    const original = await db('messages').where({ id: inboundMessageId }).first();
    const fixture = { account_id: composeMailboxId, direction: 'inbound', from_email: inboxSender, to_email: original.to_email, classification: 'unmatched', references_json: '[]', is_test: false };
    const newSubject = `Separate conversation ${runId}`;
    const separateId = randomUUID();
    await db('messages').insert([
      { ...fixture, id: separateId, message_id: `<separate-${runId}@example.test>`, subject: newSubject, body_text: 'A fresh email to the same person has its own conversation.', received_at: new Date(), created_at: new Date() },
      ...Array.from({ length: 18 }, (_, i) => ({ ...fixture, id: randomUUID(), message_id: `<list-${i}-${runId}@example.test>`, subject: `Independent conversation ${i}`, body_text: 'Independent email for scrolling checks.', received_at: new Date(), created_at: new Date() })),
      ...Array.from({ length: 10 }, (_, i) => ({ ...fixture, id: randomUUID(), message_id: `<thread-${i}-${runId}@example.test>`, in_reply_to: original.message_id, references_json: JSON.stringify([original.message_id]), subject: 'Re: Existing conversation', body_text: `Scrolling reply ${i}\n${'Readable email body.\n'.repeat(12)}`, received_at: new Date(Date.now() + (i + 1) * 1000), created_at: new Date(Date.now() + (i + 1) * 1000) })),
    ]);
    await page.goto(`http://127.0.0.1:3100/inbox/${inboundMessageId}`, { waitUntil: 'networkidle' });
    const listPane = page.getByRole('region', { name: 'Conversation list', exact: true });
    const reader = page.getByRole('region', { name: 'Conversation messages', exact: true });
    await expect(listPane.locator('.conversation-item').filter({ hasText: `Contactless inbox QA ${runId}` })).toHaveCount(1);
    await expect(listPane.locator('.conversation-item').filter({ hasText: newSubject })).toHaveCount(1);
    await expect(reader.locator('.thread-message')).toHaveCount(12);
    await expect(reader.getByText('A fresh email to the same person has its own conversation.', { exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 1366, height: 768 });
    const compactLayout = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const list = rect('.conversation-list'), row = rect('.conversation-list .conversation-item');
      return { list_height: list.height, row_height: row.height, reader_height: rect('.thread-messages').height, heading_height: rect('.conversation-heading').height, composer_height: rect('.reply-composer').height };
    });
    expect(compactLayout.list_height, 'Laptop email list has space for at least five rows').toBeGreaterThanOrEqual(480);
    expect(compactLayout.row_height, 'Email list rows stay compact').toBeLessThanOrEqual(92);
    expect(compactLayout.reader_height, 'The email body gets most of the laptop reading pane').toBeGreaterThanOrEqual(400);
    expect(compactLayout.heading_height).toBeLessThanOrEqual(85);
    expect(compactLayout.composer_height).toBeLessThanOrEqual(100);
    console.log('Inbox laptop space:', JSON.stringify(compactLayout));
    await page.screenshot({ path: path.join(artifacts, 'crm-inbox-compact-laptop.png'), fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 1100 });
    const fixedBox = await page.getByRole('region', { name: 'Outbox', exact: true }).boundingBox();
    const headerBox = await page.locator('.conversation-heading').boundingBox();
    const composerBox = await page.locator('.reply-composer').boundingBox();
    const leftScroll = await listPane.evaluate(node => { node.scrollTop = node.scrollHeight; return node.scrollTop; });
    expect(leftScroll).toBeGreaterThan(100);
    expect(await reader.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(100);
    await reader.evaluate(node => { node.scrollTop = 0; });
    await expect.poll(() => reader.evaluate(node => node.scrollTop)).toBe(0);
    expect(await listPane.evaluate(node => node.scrollTop)).toBe(leftScroll);
    expect((await page.getByRole('region', { name: 'Outbox', exact: true }).boundingBox()).y).toBe(fixedBox.y);
    expect((await page.locator('.conversation-heading').boundingBox()).y).toBe(headerBox.y);
    expect((await page.locator('.reply-composer').boundingBox()).y).toBe(composerBox.y);
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(1100);
    expect(await page.evaluate(() => ({ y: window.scrollY, overflow: document.documentElement.scrollHeight - window.innerHeight }))).toEqual({ y: 0, overflow: 0 });
    await listPane.evaluate(node => { node.scrollTop = 0; });
    const newReplyId = randomUUID();
    const draft = page.getByRole('textbox', { name: 'Reply message', exact: true });
    await draft.fill('Keep this draft while I read older replies.');
    await db('messages').insert({ ...fixture, id: newReplyId, message_id: `<new-while-reading-${runId}@example.test>`, in_reply_to: original.message_id, references_json: JSON.stringify([original.message_id]), subject: 'Re: Existing conversation', body_text: 'A new reply while reading earlier messages.', received_at: new Date(Date.now() + 20000), created_at: new Date(Date.now() + 20000) });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(reader.locator('.thread-message')).toHaveCount(13, { timeout: 16000 });
    await expect(page.getByRole('button', { name: 'New messages: jump to latest', exact: true })).toBeVisible();
    expect(await reader.evaluate(node => node.scrollTop)).toBe(0);
    await expect(draft).toHaveValue('Keep this draft while I read older replies.');
    await page.getByRole('button', { name: 'New messages: jump to latest', exact: true }).click();
    await expect.poll(() => reader.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
    const queued = await mutate(page, 'POST', `/inbox/${newReplyId}/reply`, () => page.getByRole('button', { name: 'Send reply', exact: true }).click());
    const job = await db('jobs').where({ id: queued.job_id }).first();
    expect(typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload).toMatchObject({ reply_source_id: newReplyId });
    expect(await db('send_attempts')).toHaveLength(0);
    await expect.poll(() => reader.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
    await page.screenshot({ path: path.join(artifacts, 'crm-inbox-fixed-panes.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.locator('#workspace-navigation').evaluate(node => node.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    await expect(page.locator('.inbox-sidebar')).toBeHidden();
    await expect(page.getByRole('link', { name: 'All conversations', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Reply message', exact: true })).toBeVisible();
    await expect.poll(() => reader.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
    expect((await reader.boundingBox()).height, 'Mobile reading pane remains large with the reply confirmation visible').toBeGreaterThanOrEqual(400);
    await noPageOverflow(page, '390px selected email conversation');
    expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBe(0);
    await page.screenshot({ path: path.join(artifacts, 'crm-inbox-reader-mobile.png'), fullPage: true, animations: 'disabled' });
    await page.getByRole('link', { name: 'All conversations', exact: true }).click();
    await expect(page.locator('.inbox-sidebar')).toBeVisible();
    await expect(page.locator('.conversation-detail')).toBeHidden();
    await page.setViewportSize({ width: 1440, height: 1100 });
  });
  await check('Normal Inbox compose modal fits a mobile screen', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('http://127.0.0.1:3100/inbox', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New message', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New message', exact: true });
    await expect(dialog.getByLabel('To email', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Message', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport();
    await noPageOverflow(page, '390px Inbox compose');
    await page.screenshot({ path: path.join(artifacts, 'crm-inbox-compose-mobile.png'), fullPage: true });
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await page.setViewportSize({ width: 1440, height: 1100 });
  });
  await check('Every dashboard page renders without runtime or API failures', async () => {
    for (const route of ['overview', 'prospects', 'campaigns', 'templates', 'inbox', 'pipeline', 'analytics', 'suppressions', 'settings/accounts', 'settings/sending', 'settings/tracking', 'settings/crm', 'settings/team', 'health']) {
      await page.goto(`http://127.0.0.1:3100/${route}`, { waitUntil: 'networkidle' });
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByText('We couldn’t complete that request', { exact: true })).toHaveCount(0);
      await noPageOverflow(page, route);
      for (const search of await page.locator('.search-field').all()) {
        const clearance = await search.evaluate(node => {
          const input = node.querySelector('input'), icon = node.querySelector('svg');
          if (!input || !icon) return 100;
          return input.getBoundingClientRect().left + parseFloat(getComputedStyle(input).paddingLeft) - icon.getBoundingClientRect().right;
        });
        expect(clearance, `${route} search text clears its icon`).toBeGreaterThanOrEqual(6);
      }
      await page.evaluate(() => document.fonts.ready);
      const typography = await page.locator('.page-header h1').evaluate(node => ({ family: getComputedStyle(node).fontFamily, size: parseFloat(getComputedStyle(node).fontSize) }));
      expect(typography.family).not.toContain('Manrope');
      expect(typography.size, `${route} heading remains readable`).toBeGreaterThanOrEqual(route === 'inbox' ? 24 : 28);
      await page.screenshot({ path: path.join(artifacts, `crm-modern-${route.replaceAll('/', '-')}.png`), fullPage: true });
    }
  });
  await check('Tablet and mobile layouts keep scrolling inside panels', async () => {
    for (const viewport of [{ width: 1024, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const route of ['overview', 'prospects', 'pipeline', 'settings/sending', 'analytics', 'inbox']) {
        await page.goto(`http://127.0.0.1:3100/${route}`, { waitUntil: 'networkidle' });
        await noPageOverflow(page, `${viewport.width}px ${route}`);
        await page.screenshot({ path: path.join(artifacts, `crm-modern-${viewport.width}-${route.replaceAll('/', '-')}.png`), fullPage: true });
      }
    }
    await page.goto('http://127.0.0.1:3100/overview', { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.join(artifacts, 'crm-mobile.png'), fullPage: true });
  });
  await check('Responsive navigation supports keyboard focus, Escape and page navigation', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('http://127.0.0.1:3100/overview', { waitUntil: 'networkidle' });
    const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
    await expect(page.locator('#workspace-navigation')).toHaveAttribute('inert', '');
    await menu.click();
    const drawer = page.getByRole('dialog', { name: 'Workspace navigation', exact: true });
    await expect(drawer).toBeVisible();
    await expect(page.locator('.main-shell')).toHaveAttribute('inert', '');
    await expect(drawer.getByRole('button', { name: 'Close navigation', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(drawer.getByRole('button', { name: 'Sign out', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeFocused();
    await expect(page.locator('.main-shell')).not.toHaveAttribute('inert', '');
    await menu.click();
    await drawer.getByRole('link', { name: 'Analytics', exact: true }).click();
    await expect(page).toHaveURL(/\/analytics$/);
    await expect(page.locator('#workspace-navigation')).toHaveAttribute('inert', '');
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto('http://127.0.0.1:3100/overview', { waitUntil: 'networkidle' });
    await expect(page.locator('#workspace-navigation')).not.toHaveAttribute('inert', '');
    await page.evaluate(() => document.fonts.ready);
    const font = await page.locator('body').evaluate(node => ({ family: getComputedStyle(node).fontFamily, loaded: [...document.fonts].filter(face => face.status === 'loaded').map(face => face.family) }));
    const normalize = value => value.replaceAll('"', '').replaceAll("'", '').trim();
    expect(font.loaded.map(normalize), 'Self-hosted variable font loads successfully').toContain(normalize(font.family.split(',')[0]));
    expect(font.family).not.toContain('DM Sans');
  });
  expect(failures, 'Browser runtime errors').toEqual([]);
  console.log(`Browser acceptance complete: ${checks.length} checks; live sending disabled; isolated database ${database}.`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, 'crm-browser-failure.png'), fullPage: true }).catch(() => {});
  console.error('Browser acceptance failed:', error instanceof Error ? error.message : 'Unknown error');
  console.error('Recent API responses:', apiTrail.slice(-14).join(' | '));
  if (failures.length) console.error('Browser runtime errors:', failures.join(' | '));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await stopNextServer();
  if (db) await db.destroy();
}
