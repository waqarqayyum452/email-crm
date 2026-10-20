import 'dotenv/config';
import process from 'node:process';
import { connect } from 'node:tls';
import knex from 'knex';
import { validateMailTarget } from '../server/lib/mail-target.js';

type Evidence = { check: string; ok: boolean; evidence: Record<string, unknown> };
const checks: Evidence[] = [];
function record(check: string, ok: boolean, evidence: Record<string, unknown>) {
  checks.push({ check, ok, evidence });
}
function safeError(error: unknown): Record<string, unknown> {
  // SQL/network exception messages can contain connection details or SQL values.
  const candidate = error as { code?: unknown; errno?: unknown; sqlState?: unknown };
  const code = typeof candidate.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(candidate.code) ? candidate.code : 'CHECK_FAILED';
  return { code, ...(typeof candidate.errno === 'number' ? { errno: candidate.errno } : {}) };
}
const env = process.env;
const [major, minor] = process.versions.node.split('.').map(Number);
const runtimeSupported = major === 24 || (major === 22 && minor >= 12);
record('node', runtimeSupported, { version: process.versions.node, required: 'Node.js 24.x LTS or 22.x >= 22.12.0' });
const missing = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'ENCRYPTION_KEY', 'SCHEDULER_SECRET'].filter((key) => !env[key]);
const encryptionValid = /^[A-Za-z0-9+/]{43}=$/.test(env.ENCRYPTION_KEY || '') && Buffer.from(env.ENCRYPTION_KEY || '', 'base64').length === 32;
const schedulerValid = (env.SCHEDULER_SECRET || '').length >= 32 && !/[\r\n]/.test(env.SCHEDULER_SECRET || '');
let appUrlValid = false;
try {
  const url = new URL(env.APP_URL || '');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  appUrlValid = !url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || (env.NODE_ENV !== 'production' && local && url.protocol === 'http:'));
} catch { /* Report only the name of the invalid setting. */ }
record('environment', missing.length === 0 && encryptionValid && schedulerValid && appUrlValid, {
  missing,
  encryption_key_valid: encryptionValid,
  scheduler_secret_valid: schedulerValid,
  app_url_valid: appUrlValid,
  sending_gate_enabled: env.LIVE_SEND_ENABLED === 'true',
  credentials_printed: false,
});

const ssl = env.DB_SSL === 'true' ? { rejectUnauthorized: true, ...(env.DB_SSL_CA ? { ca: env.DB_SSL_CA.replace(/\\n/g, '\n') } : {}) } : undefined;
const database = knex({
  client: 'mysql2',
  connection: {
    host: env.DB_HOST || '127.0.0.1', port: Number(env.DB_PORT || 3306),
    database: env.DB_NAME, user: env.DB_USER, password: env.DB_PASSWORD,
    timezone: 'Z', connectTimeout: 8_000,
    ...(ssl ? { ssl } : {}),
  },
  pool: { min: 0, max: 1, acquireTimeoutMillis: 10_000, afterCreate(connection: { query: (sql: string, callback: (error: unknown) => void) => void }, done: (error: unknown, connection: unknown) => void) { connection.query("SET time_zone = '+00:00'", (error) => done(error, connection)); } },
});
try {
  const [rows] = await database.raw('SELECT VERSION() AS version, UTC_TIMESTAMP(3) AS utc_now, @@session.time_zone AS session_timezone');
  const row = rows[0];
  const version = String(row.version);
  const maria = /mariadb/i.test(version);
  const mariaVersion = version.match(/(\d+)\.(\d+)\.\d+-MariaDB/i);
  const mariaSupported = Boolean(mariaVersion && (Number(mariaVersion[1]) > 10 || (Number(mariaVersion[1]) === 10 && Number(mariaVersion[2]) >= 11)));
  const supported = maria ? mariaSupported : Number(version.split('.')[0]) >= 8;
  const utcTime = row.utc_now instanceof Date ? row.utc_now : new Date(String(row.utc_now).replace(' ', 'T') + 'Z');
  const driftSeconds = Math.round(Math.abs(Date.now() - utcTime.getTime()) / 1000);
  record('database', supported && Number.isFinite(driftSeconds) && driftSeconds <= 60, {
    version, engine: maria ? 'mariadb' : 'mysql', supported_version: supported, utc_clock_drift_seconds: driftSeconds,
    session_timezone: row.session_timezone,
  });
  const lockName = `email-crm-doctor-${process.pid}`;
  await database.transaction(async (trx) => {
    const [lockRows] = await trx.raw('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
    try {
      if (Number(lockRows[0].acquired) !== 1) throw new Error('Lock unavailable');
      // Locks no rows, changes no data, and confirms required queue SQL support.
      await trx.raw('SELECT id FROM jobs WHERE 1 = 0 FOR UPDATE SKIP LOCKED');
      const [engines] = await trx.raw('SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', ['jobs']);
      const innodb = String(engines[0]?.engine).toLowerCase() === 'innodb';
      record('queue_sql', innodb, { advisory_locks: true, skip_locked: true, queue_engine: innodb ? 'InnoDB' : 'unsupported', persistent_data_changed: false });
    } finally {
      await trx.raw('SELECT RELEASE_LOCK(?)', [lockName]);
    }
  });
} catch (error) {
  record('database_or_queue_sql', false, { ...safeError(error), hint: 'Check DB credentials, MySQL version, migration state, privileges, and network access privately.' });
} finally {
  await database.destroy();
}

async function probe(kind: 'smtp' | 'imap', defaultHost: string, defaultPort: number) {
  const prefix = `DOCTOR_${kind.toUpperCase()}`;
  const host = env[`${prefix}_HOST`] || defaultHost;
  const port = Number(env[`${prefix}_PORT`] || defaultPort);
  try {
    // Implicit TLS only. Authenticated STARTTLS testing belongs in Settings.
    if ((kind === 'smtp' && port !== 465) || (kind === 'imap' && port !== 993)) {
      record(`${kind}_tls`, false, { hint: 'Doctor checks implicit TLS on SMTP 465 / IMAP 993. Use Settings for an authenticated configured connection test.' });
      return;
    }
    const target = await validateMailTarget(host, port, kind);
    const evidence = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = connect({ host: target.address, port, servername: target.servername, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
      socket.setTimeout(8_000, () => socket.destroy(new Error('TLS timeout')));
      socket.once('error', reject);
      socket.once('secureConnect', () => {
        const result = { tls_verified: socket.authorized, protocol: socket.getProtocol(), authentication_attempted: false, mail_sent: false };
        socket.end();
        resolve(result);
      });
    });
    record(`${kind}_tls`, true, evidence);
  } catch (error) {
    record(`${kind}_tls`, false, { ...safeError(error), hint: 'Check public DNS, certificate validity, outbound reachability, and provider settings.' });
  }
}
await probe('smtp', 'smtp.hostinger.com', 465);
await probe('imap', 'imap.hostinger.com', 993);

if (env.DOCTOR_CHECK_HTTP === 'true') {
  try {
    const response = await fetch(`http://127.0.0.1:${Number(env.PORT || 3000)}/healthz`, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
    await response.body?.cancel();
    record('http_liveness', response.ok, { status: response.status, readiness_proven: false });
  } catch (error) { record('http_liveness', false, safeError(error)); }
}
for (const check of checks) console.log(JSON.stringify(check));
const ok = checks.every((check) => check.ok);
console.log(JSON.stringify({ ok, checked_at: new Date().toISOString(), notes: 'No mailbox authentication or mail submission attempted. This is point-in-time evidence; scheduler continuity, real credentials, provider permission, restarts and application acceptance tests remain separate.' }));
process.exitCode = ok ? 0 : 1;
