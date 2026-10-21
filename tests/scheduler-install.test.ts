import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const fixture = vi.hoisted(() => ({ real: '', prefix: '/home/u123456789/domains/crm.example.com', unsafe: new Set<string>(), operations: [] as { operation: string; target: string; mode?: number }[], failRename: false }));

// The public installer still derives and validates its Linux path. Only filesystem
// calls are redirected into a disposable directory for this Windows-safe test.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  const local = (value: unknown) => typeof value === 'string' && value.startsWith(fixture.prefix) ? path.join(fixture.real, ...value.slice(fixture.prefix.length).split('/').filter(Boolean)) : value;
  return {
    ...actual,
    lstat: async (value: string) => {
      const info = await actual.lstat(local(value) as string);
      if (fixture.unsafe.has(value)) return { ...info, isSymbolicLink: () => true, isDirectory: () => info.isDirectory(), isFile: () => info.isFile() };
      return info;
    },
    realpath: async (value: string) => {
      const result = await actual.realpath(local(value) as string);
      if (result === fixture.real || result.startsWith(fixture.real + path.sep)) return fixture.prefix + result.slice(fixture.real.length).split(path.sep).join('/');
      return result;
    },
    mkdir: async (value: string, options?: { mode?: number }) => {
      fixture.operations.push({ operation: 'mkdir', target: value, mode: options?.mode });
      return actual.mkdir(local(value) as string, options);
    },
    open: async (value: string, flags: number, mode?: number) => {
      fixture.operations.push({ operation: 'open', target: value, mode });
      return actual.open(local(value) as string, flags, mode);
    },
    chmod: async (value: string, mode: number) => {
      fixture.operations.push({ operation: 'chmod', target: value, mode });
      return actual.chmod(local(value) as string, mode);
    },
    rename: async (source: string, target: string) => {
      if (fixture.failRename) throw new Error('Sensitive raw filesystem failure');
      return actual.rename(local(source) as string, local(target) as string);
    },
    unlink: async (value: string) => actual.unlink(local(value) as string),
  };
});

import { installHostingerScheduler } from '../server/lib/scheduler-install.js';

const privateDirectory = fixture.prefix + '/.email-crm-scheduler';
const testSecret = 'scheduler-install-private-fixture-123456789';
const environment = () => ({ NODE_ENV: 'production', HOSTINGER_ACCOUNT: 'u123456789', APP_URL: 'https://crm.example.com', HOSTINGER_SCHEDULER_DIR: privateDirectory, SCHEDULER_SECRET: testSecret });

beforeEach(async () => {
  fixture.real = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'crm-private-scheduler-')));
  fixture.unsafe.clear(); fixture.operations.length = 0; fixture.failRename = false;
});
afterEach(async () => { await fs.rm(fixture.real, { recursive: true, force: true }); });

describe('private Hostinger scheduler installation', () => {
  it('installs a CLI caller and owner-only secret separately, with a secret-free cron command', async () => {
    const result = await installHostingerScheduler(environment());
    expect(result).toEqual({ installed: true, cron_command: `/usr/bin/php ${privateDirectory}/tick.php` });
    const folder = path.join(fixture.real, '.email-crm-scheduler');
    const config = JSON.parse(await fs.readFile(path.join(folder, 'scheduler.json'), 'utf8'));
    expect(config).toEqual({ endpoint: 'https://crm.example.com/internal/tick', secret: testSecret, mode: 'inbox' });
    const caller = await fs.readFile(path.join(folder, 'tick.php'), 'utf8');
    expect(caller).not.toContain(testSecret); expect(JSON.stringify(result)).not.toContain(testSecret);
    expect(fixture.operations.filter(op => op.operation === 'open')).toHaveLength(2);
    expect(fixture.operations.filter(op => op.operation === 'open').every(op => op.mode === 0o600)).toBe(true);
    expect(fixture.operations).toContainEqual({ operation: 'chmod', target: privateDirectory, mode: 0o700 });
    if (process.platform !== 'win32') {
      expect((await fs.stat(folder)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(folder, 'scheduler.json'))).mode & 0o777).toBe(0o600);
    }
    // Reinstallation changes the private config atomically without creating a
    // second command, exposing credentials, or leaving temporary files behind.
    await installHostingerScheduler({ ...environment(), SCHEDULER_SECRET: testSecret + '-rotated' });
    expect(JSON.parse(await fs.readFile(path.join(folder, 'scheduler.json'), 'utf8')).secret).toBe(testSecret + '-rotated');
    expect((await fs.readdir(folder)).sort()).toEqual(['scheduler.json', 'tick.php']);
  });

  it('rejects nonproduction configuration, unsafe URLs and any alternate destination before filesystem writes', async () => {
    for (const change of [
      { NODE_ENV: 'development' }, { HOSTINGER_ACCOUNT: '../other' }, { APP_URL: 'http://crm.example.com' },
      { APP_URL: 'https://user:password@crm.example.com' }, { APP_URL: 'https://crm.example.com/path' },
      { APP_URL: 'https://crm.example.com?secret=value' }, { APP_URL: 'https://127.0.0.1' },
      { HOSTINGER_SCHEDULER_DIR: fixture.prefix + '/public_html' }, { HOSTINGER_SCHEDULER_DIR: privateDirectory + '/..' },
      { SCHEDULER_SECRET: 'short' }, { SCHEDULER_SECRET: testSecret + '\nHeader: value' },
    ]) {
      await expect(installHostingerScheduler({ ...environment(), ...change })).rejects.toMatchObject({ code: 'SCHEDULER_INSTALL_CONFIG' });
    }
    expect(fixture.operations).toHaveLength(0);
  });

  it('refuses symlinked site directories, scheduler directories and existing files', async () => {
    fixture.unsafe.add(fixture.prefix);
    await expect(installHostingerScheduler(environment())).rejects.toMatchObject({ code: 'SCHEDULER_INSTALL_UNSAFE_PATH' });
    fixture.unsafe.clear();
    await installHostingerScheduler(environment());
    for (const target of [privateDirectory, privateDirectory + '/scheduler.json', privateDirectory + '/tick.php']) {
      fixture.unsafe.add(target);
      await expect(installHostingerScheduler(environment())).rejects.toMatchObject({ code: 'SCHEDULER_INSTALL_UNSAFE_PATH' });
      fixture.unsafe.delete(target);
    }
    const lock = path.join(fixture.real, '.email-crm-scheduler', 'tick.lock');
    await fs.writeFile(lock, ''); fixture.unsafe.add(privateDirectory + '/tick.lock');
    await expect(installHostingerScheduler(environment())).rejects.toMatchObject({ code: 'SCHEDULER_INSTALL_UNSAFE_PATH' });
  });

  it('preserves existing config on an atomic write failure and returns a redacted error', async () => {
    await installHostingerScheduler(environment());
    const folder = path.join(fixture.real, '.email-crm-scheduler');
    fixture.failRename = true;
    await expect(installHostingerScheduler(environment())).rejects.toMatchObject({ code: 'SCHEDULER_INSTALL_FAILED', message: 'Private scheduler installation failed.' });
    expect(JSON.parse(await fs.readFile(path.join(folder, 'scheduler.json'), 'utf8')).secret).toBe(testSecret);
    expect((await fs.readdir(folder)).sort()).toEqual(['scheduler.json', 'tick.php']);
  });

  it('refuses hard-linked existing secrets instead of replacing an unexpected shared file', async () => {
    await installHostingerScheduler(environment());
    const config = path.join(fixture.real, '.email-crm-scheduler', 'scheduler.json');
    await fs.link(config, path.join(fixture.real, 'unexpected-link.json'));
    await expect(installHostingerScheduler(environment())).rejects.toMatchObject({ code: 'SCHEDULER_INSTALL_UNSAFE_PATH' });
    expect(JSON.parse(await fs.readFile(config, 'utf8')).secret).toBe(testSecret);
  });
});
