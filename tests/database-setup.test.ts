import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { localConfig, setupErrorMessage, setupLocalDatabase, supportedEngine } from '../scripts/lib/database-setup.js';

const fsFailures = vi.hoisted(() => ({ write: false, rename: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (!fsFailures.write) return handle;
      return {
        writeFile: async () => { throw Object.assign(new Error('private SQL/password disk detail'), { code: 'ENOSPC' }); },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fsFailures.rename) throw Object.assign(new Error('private SQL/password rename detail'), { code: 'EPERM' });
      return actual.rename(...args);
    },
  };
});

const directories: string[] = [];
const originalEncryptionKey = Buffer.alloc(32, 7).toString('base64');
const originalSchedulerSecret = Buffer.alloc(32, 9).toString('base64');
const originalText = [
  '# Local fixture; contains no user credentials.',
  'DB_HOST=127.0.0.1', 'DB_PORT=3306', 'DB_NAME=email_crm', 'DB_USER=email_crm',
  'DB_PASSWORD=test-app-only', `ENCRYPTION_KEY=${originalEncryptionKey}`,
  `SCHEDULER_SECRET=${originalSchedulerSecret}`, 'LIVE_SEND_ENABLED=false', '',
].join('\r\n');

async function fixture(text = originalText) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'email-crm-setup-test-'));
  directories.push(directory);
  const envPath = path.join(directory, '.env');
  await writeFile(envPath, text, 'utf8');
  return envPath;
}

type Call = { sql: string; values?: unknown[] };
type State = {
  version?: string;
  tableCount?: unknown;
  secretCount?: unknown;
  accounts?: { User: string; Host: string; plugin: string }[];
  globalGrants?: { PRIVILEGE_TYPE: string }[];
  rootFailure?: unknown;
  queryFailure?: unknown;
};

function database(state: State = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const admin = {
    end: vi.fn(async () => {}),
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (state.queryFailure) throw state.queryFailure;
      if (sql === 'SELECT VERSION() AS version') return [[{ version: state.version ?? '11.4.5-MariaDB' }], []];
      if (sql.includes('@@GLOBAL.partial_revokes')) return [[{ enabled: 0 }], []];
      if (sql.includes('information_schema.tables')) return [[{ count: Object.hasOwn(state, 'tableCount') ? state.tableCount : 0 }], []];
      if (sql.includes('WHERE smtp_secret')) return [[{ count: Object.hasOwn(state, 'secretCount') ? state.secretCount : 0 }], []];
      if (sql.includes('FROM mysql.user')) return [state.accounts ?? [], []];
      if (sql.includes('information_schema.user_privileges')) return [state.globalGrants ?? [], []];
      if (sql.includes('FROM mysql.roles_mapping') || sql.includes('FROM mysql.role_edges')) return [[{ count: 0 }], []];
      if (/^(CREATE|ALTER|GRANT) /.test(sql)) return [{ affectedRows: 0 }, []];
      throw new Error(`Unexpected test query: ${sql}`);
    }),
  };
  const probe = { query: vi.fn(async () => [[{ result: 1 }], []]), end: vi.fn(async () => {}) };
  const connect = vi.fn(async (options: Record<string, unknown>) => {
    if (options.user === 'root') {
      if (state.rootFailure) throw state.rootFailure;
      return admin;
    }
    return probe;
  });
  return {
    calls, logs, admin, probe, connect,
    options: (envPath: string) => ({ envPath, rootPassword: 'test-root-only', connect, log: (message: string) => logs.push(message) }),
    mutations: () => calls.filter(call => /^(CREATE|ALTER|GRANT) /.test(call.sql)),
  };
}

afterEach(async () => {
  fsFailures.write = false;
  fsFailures.rename = false;
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('local database onboarding safeguards', () => {
  it('rejects remote servers, system databases and administrator accounts', () => {
    for (const values of [
      { DB_HOST: 'database.example.com' }, { DB_NAME: 'mysql' }, { DB_NAME: 'information_schema' },
      { DB_USER: 'root' }, { DB_USER: 'mariadb_sys' }, { DB_PORT: '3306;DROP DATABASE mysql' },
    ]) expect(() => localConfig({ DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_NAME: 'email_crm', DB_USER: 'email_crm', ...values })).toThrow();
  });

  it('recognizes MariaDB compatibility prefixes and rejects unsupported engines', () => {
    expect(supportedEngine('5.5.5-10.11.14-MariaDB')).toBe('mariadb');
    expect(supportedEngine('11.4.5-MariaDB-log')).toBe('mariadb');
    expect(supportedEngine('8.0.44')).toBe('mysql');
    expect(() => supportedEngine('5.5.5-10.6.20-MariaDB')).toThrow();
    expect(() => supportedEngine('5.7.44')).toThrow();
  });

  it('leaves configuration untouched after a rejected root login and exposes no error details', async () => {
    const envPath = await fixture();
    const failure = Object.assign(new Error('SQL root password=test-root-only'), { code: 'ER_ACCESS_DENIED_ERROR' });
    const db = database({ rootFailure: failure });
    await expect(setupLocalDatabase(db.options(envPath))).rejects.toBe(failure);
    expect(await readFile(envPath, 'utf8')).toBe(originalText);
    expect(db.mutations()).toEqual([]);
    expect(db.logs).toEqual([]);
    expect(setupErrorMessage(failure)).toContain('root login was rejected');
    expect(setupErrorMessage(failure)).not.toContain('test-root-only');
  });

  it('saves the generated app password that was bound to both local accounts and verifies it', async () => {
    const envPath = await fixture();
    const db = database();
    await setupLocalDatabase(db.options(envPath));
    const savedText = await readFile(envPath, 'utf8');
    const saved = parse(savedText);
    expect(saved.DB_PASSWORD).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(saved.DB_PASSWORD).not.toBe('test-app-only');
    expect(saved.ENCRYPTION_KEY).not.toBe(originalEncryptionKey);
    expect(Buffer.from(saved.ENCRYPTION_KEY, 'base64')).toHaveLength(32);
    expect(saved.SCHEDULER_SECRET).not.toBe(originalSchedulerSecret);
    expect(saved.LIVE_SEND_ENABLED).toBe('false');
    expect(savedText).not.toContain('test-root-only');
    const passwordStatements = db.calls.filter(call => /^(CREATE USER|ALTER USER)/.test(call.sql));
    expect(passwordStatements).toHaveLength(4);
    for (const host of ['127.0.0.1', 'localhost']) {
      expect(passwordStatements.filter(call => call.values?.[1] === host)).toHaveLength(2);
      for (const call of passwordStatements.filter(call => call.values?.[1] === host)) {
        expect(call.values).toEqual(['email_crm', host, saved.DB_PASSWORD]);
        expect(call.sql).not.toContain(saved.DB_PASSWORD);
      }
    }
    const grants = db.calls.filter(call => call.sql.startsWith('GRANT '));
    expect(grants).toHaveLength(2);
    expect(grants.every(call => call.sql.includes('`email\\_crm`.*'))).toBe(true);
    expect(db.connect.mock.calls[1][0]).toMatchObject({ user: 'email_crm', password: saved.DB_PASSWORD });
    expect(db.probe.query).toHaveBeenCalledWith('SELECT 1');
    expect(db.probe.end).toHaveBeenCalledOnce();
    expect(db.admin.end).toHaveBeenCalledOnce();
    expect(db.logs.join('\n')).not.toContain(saved.DB_PASSWORD);
    expect(db.logs.join('\n')).not.toContain(saved.ENCRYPTION_KEY);
    await expect(readFile(envPath + '.setup-pending')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves the encryption key required by saved mailbox credentials', async () => {
    const envPath = await fixture();
    const db = database({ tableCount: 1, secretCount: 2 });
    await expect(setupLocalDatabase(db.options(envPath))).resolves.toMatchObject({ encryptionKeyPreserved: true });
    const saved = parse(await readFile(envPath, 'utf8'));
    expect(saved.ENCRYPTION_KEY).toBe(originalEncryptionKey);
    expect(saved.SCHEDULER_SECRET).not.toBe(originalSchedulerSecret);
    expect(saved.DB_PASSWORD).not.toBe('test-app-only');
  });

  it.each([
    { accounts: [{ User: 'email_crm', Host: 'localhost', plugin: 'unix_socket' }] },
    { globalGrants: [{ PRIVILEGE_TYPE: 'SUPER' }] },
  ])('aborts before changes when the configured account is not dedicated: %j', async state => {
    const envPath = await fixture();
    const db = database(state);
    await expect(setupLocalDatabase(db.options(envPath))).rejects.toThrow();
    expect(db.mutations()).toEqual([]);
    expect(await readFile(envPath, 'utf8')).toBe(originalText);
    expect(db.admin.end).toHaveBeenCalledOnce();
  });

  it('fails closed if the mailbox secret count cannot be interpreted', async () => {
    for (const secretCount of ['not-a-number', -1, 0.5, {}, [], false, null, undefined, '']) {
      const envPath = await fixture();
      const db = database({ tableCount: 1, secretCount });
      await expect(setupLocalDatabase(db.options(envPath))).rejects.toThrow();
      expect(db.mutations()).toEqual([]);
      expect(await readFile(envPath, 'utf8')).toBe(originalText);
    }
  });

  it('does not replace the key if saved ciphertext exists but the original key is missing', async () => {
    const text = originalText.replace(`ENCRYPTION_KEY=${originalEncryptionKey}`, 'ENCRYPTION_KEY=');
    const envPath = await fixture(text);
    const db = database({ tableCount: 1, secretCount: 1 });
    await expect(setupLocalDatabase(db.options(envPath))).rejects.toThrow('Restore their original encryption key');
    expect(db.mutations()).toEqual([]);
    expect(await readFile(envPath, 'utf8')).toBe(text);
  });

  it('does not run SQL changes when writing the pending configuration fails', async () => {
    const envPath = await fixture();
    const db = database();
    fsFailures.write = true;
    await expect(setupLocalDatabase(db.options(envPath))).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(db.mutations()).toEqual([]);
    expect(await readFile(envPath, 'utf8')).toBe(originalText);
    await expect(readFile(envPath + '.setup-pending')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(db.logs.join('\n')).not.toContain('private SQL/password');
  });

  it('retains the matching private configuration if final replacement fails after SQL changes', async () => {
    const envPath = await fixture();
    const db = database();
    fsFailures.rename = true;
    await expect(setupLocalDatabase(db.options(envPath))).rejects.toMatchObject({ code: 'EPERM' });
    expect(await readFile(envPath, 'utf8')).toBe(originalText);
    const pending = parse(await readFile(envPath + '.setup-pending', 'utf8'));
    expect(db.mutations().some(call => call.values?.includes(pending.DB_PASSWORD))).toBe(true);
    expect(db.logs.join('\n')).toContain('.env.setup-pending');
    expect(db.logs.join('\n')).not.toContain(pending.DB_PASSWORD);
    expect(db.logs.join('\n')).not.toContain('private SQL/password');
  });

  it('redacts raw SQL and unknown error strings from displayed setup errors', async () => {
    const envPath = await fixture();
    const secret = 'private-test-secret';
    const failure = Object.assign(new Error(`ALTER USER password=${secret}`), { sql: `IDENTIFIED BY '${secret}'` });
    const db = database({ queryFailure: failure });
    await expect(setupLocalDatabase(db.options(envPath))).rejects.toBe(failure);
    expect(db.logs).toEqual([]);
    expect(setupErrorMessage(failure)).not.toContain(secret);
    expect(setupErrorMessage(`SQL password=${secret}`)).not.toContain(secret);
    expect(await readFile(envPath, 'utf8')).toBe(originalText);
  });
});
