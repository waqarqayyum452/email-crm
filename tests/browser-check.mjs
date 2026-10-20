import { chromium, expect } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import mysql from 'mysql2/promise';

// Run only against an explicitly isolated local database. Never uses a mailbox connection.
const database = process.env.DB_NAME || 'email_crm_ui_test';
if (!/^[a-zA-Z0-9_]+_ui_test$/.test(database)) throw new Error('Browser checks require DB_NAME ending in _ui_test.');
if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST || '127.0.0.1')) throw new Error('Browser checks require a loopback database host.');
Object.assign(process.env, {
  DB_HOST: process.env.DB_HOST || '127.0.0.1', DB_PORT: process.env.DB_PORT || '3306', DB_USER: process.env.DB_USER || 'root', DB_PASSWORD: process.env.DB_PASSWORD || '',
  DB_NAME: database, NODE_ENV: 'test', PORT: '3100', APP_URL: 'http://127.0.0.1:3100',
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
  const { createApp } = await import('../dist/server/app.js');
  server = await new Promise((resolve, reject) => { const listening = createApp().listen(3100, '127.0.0.1', () => resolve(listening)); listening.once('error', reject); });
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on('pageerror', error => failures.push(error.message));
  page.on('response', response => { const pathname = new URL(response.url()).pathname; if (pathname.startsWith('/api/')) apiTrail.push(`${response.request().method()} ${pathname}: ${response.status()}`); });
  await page.goto('http://127.0.0.1:3100', { waitUntil: 'networkidle' });
  await check('Owner signs in with session and CSRF', async () => {
    await page.getByLabel('Email address', { exact: true }).fill(ownerEmail);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await mutate(page, 'POST', '/auth/login', () => page.getByRole('button', { name: 'Sign in to workspace' }).click());
    await expect(page.getByRole('heading', { name: 'Good to see you, Browser.' })).toBeVisible();
    await expect(page.getByText('Automation paused', { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'crm-overview.png'), fullPage: true });
    await noPageOverflow(page, 'Desktop overview');
  });
  let contactId;
  await check('Contact creation persists through page reload', async () => {
    await page.goto('http://127.0.0.1:3100/#prospects');
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
    await page.goto(`http://127.0.0.1:3100/#prospects/${contactId}`);
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
    await page.goto('http://127.0.0.1:3100/#settings/business');
    await page.getByLabel('Business address', { exact: true }).fill('Browser QA · isolated local test database');
    await mutate(page, 'PATCH', '/settings', () => page.getByRole('button', { name: 'Save changes' }).click());
    await page.reload();
    await expect(page.getByLabel('Business address', { exact: true })).toHaveValue('Browser QA · isolated local test database');
  });
  await check('Templates save, duplicate, and preview with sample data', async () => {
    await page.goto('http://127.0.0.1:3100/#templates');
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
    await page.goto('http://127.0.0.1:3100/#campaigns');
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
    await page.goto('http://127.0.0.1:3100/#inbox', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New message', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New message', exact: true });
    await dialog.getByLabel('From mailbox', { exact: true }).selectOption(composeMailboxId);
    await dialog.getByLabel('To email', { exact: true }).fill(recipient);
    await dialog.getByLabel('Subject', { exact: true }).fill('Browser QA personal message');
    await dialog.getByLabel('Message', { exact: true }).fill('An isolated normal email queued while live sending is disabled.');
    const queued = await mutate(page, 'POST', '/inbox/compose', () => dialog.getByRole('button', { name: 'Queue message', exact: true }).click());
    await expect(dialog).not.toBeVisible();
    const job = await db('jobs').where({ id: queued.job_id }).first();
    const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
    expect(payload).toMatchObject({ is_manual: true, manual_recipient: recipient, contact_id: null });
    expect(job.account_id).toBe(composeMailboxId); expect(job.status).toBe('queued');
    expect(await db('contacts').where({ email: recipient })).toHaveLength(0);
    expect(await db('send_attempts')).toHaveLength(0);
  });
  await check('Normal Inbox replies to an unmatched sender without a contact matching flow', async () => {
    await page.goto(`http://127.0.0.1:3100/#inbox/${inboundMessageId}`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('button', { name: /match.*contact/i })).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Reply message', exact: true }).fill('A normal contactless reply, queued only.');
    await expect(page.getByRole('button', { name: 'Queue reply', exact: true })).toBeEnabled();
    const queued = await mutate(page, 'POST', `/inbox/${inboundMessageId}/reply`, () => page.getByRole('button', { name: 'Queue reply', exact: true }).click());
    const job = await db('jobs').where({ id: queued.job_id }).first();
    const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
    expect(payload).toMatchObject({ is_manual: true, is_reply: true, manual_recipient: inboxSender, reply_source_id: inboundMessageId });
    expect((await db('messages').where({ id: inboundMessageId }).first()).contact_id).toBeNull();
    expect(await db('contacts').where({ email: inboxSender })).toHaveLength(0);
    expect(await db('send_attempts')).toHaveLength(0);
    await page.screenshot({ path: path.join(artifacts, 'crm-inbox-contactless.png'), fullPage: true });
  });
  await check('Normal Inbox compose modal fits a mobile screen', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('http://127.0.0.1:3100/#inbox', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New message', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New message', exact: true });
    await expect(dialog.getByLabel('To email', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Message', { exact: true })).toBeVisible();
    await noPageOverflow(page, '390px Inbox compose');
    await page.screenshot({ path: path.join(artifacts, 'crm-inbox-compose-mobile.png'), fullPage: true });
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await page.setViewportSize({ width: 1440, height: 1100 });
  });
  await check('Every dashboard page renders without runtime or API failures', async () => {
    for (const route of ['overview', 'prospects', 'campaigns', 'templates', 'inbox', 'pipeline', 'analytics', 'suppressions', 'settings/accounts', 'settings/sending', 'settings/tracking', 'settings/crm', 'settings/team', 'health']) {
      await page.goto(`http://127.0.0.1:3100/#${route}`, { waitUntil: 'networkidle' });
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByText('We couldn’t complete that request', { exact: true })).toHaveCount(0);
      await noPageOverflow(page, route);
    }
  });
  await check('Tablet and mobile layouts keep scrolling inside panels', async () => {
    for (const viewport of [{ width: 1024, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const route of ['overview', 'prospects', 'pipeline', 'settings/sending', 'analytics', 'inbox']) {
        await page.goto(`http://127.0.0.1:3100/#${route}`, { waitUntil: 'networkidle' });
        await noPageOverflow(page, `${viewport.width}px ${route}`);
      }
    }
    await page.goto('http://127.0.0.1:3100/#overview', { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.join(artifacts, 'crm-mobile.png'), fullPage: true });
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
  if (server) await new Promise(resolve => server.close(resolve));
  if (db) await db.destroy();
}
