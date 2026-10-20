import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// This suite exercises middleware only. It cannot load .env or contact a database.
vi.mock('dotenv/config', () => ({}));
vi.mock('../server/db.js', () => ({
  db: vi.fn(() => { throw new Error('Origin tests must not query a database'); }),
  json: (value: unknown, fallback: unknown = {}) => typeof value === 'string' ? JSON.parse(value) : value ?? fallback,
}));

import { config, validateConfig } from '../server/config.js';
import { db } from '../server/db.js';
import { apiCors } from '../server/cors.js';
import { csrfProtect, requireUser } from '../server/auth.js';
import { isAllowedOrigin, parseAllowedOrigins } from '../server/lib/origins.js';

const appUrl = 'https://crm.example.test/workspace';
const ownOrigin = 'https://crm.example.test';
const csrfToken = 'a'.repeat(64);
let previousConfig: typeof config;

beforeEach(() => {
  previousConfig = { ...config };
  Object.assign(config, {
    production: false,
    port: 3000,
    appUrl,
    allowedOrigins: '',
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    schedulerSecret: 'isolated-origin-test-'.padEnd(48, 's'),
  });
  vi.mocked(db).mockClear();
});
afterEach(() => {
  Object.assign(config, previousConfig);
  expect(db).not.toHaveBeenCalled();
});

function fixture(authenticated = true) {
  const app = express(), sessions = vi.fn();
  app.use('/api', apiCors);
  app.use('/api', (req, _res, next) => {
    sessions();
    if (authenticated) {
      req.user = { id: 'origin-test-user', name: 'Origin Test', email: 'owner@example.test', role: 'owner', permissions: [] };
      req.session = { id: 'origin-test-session', csrf_token: csrfToken };
    }
    next();
  });
  app.use('/api', express.json(), csrfProtect);
  app.get('/api/resource', requireUser, (_req, res) => res.json({ ok: true }));
  app.post('/api/resource', requireUser, (_req, res) => res.json({ ok: true }));
  app.options('/api/resource', (_req, res) => res.status(200).json({ reachedApplication: true }));
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status || 500).json({ error: error.message }));
  return { app, sessions };
}

function expectOriginVary(response: { headers: Record<string, string> }) {
  expect(response.headers.vary?.toLowerCase().split(/\s*,\s*/)).toContain('origin');
}

describe('configured browser origin policy', () => {
  it('defaults to the APP_URL origin and adds exact configured origins', () => {
    expect(parseAllowedOrigins('', appUrl)).toEqual([ownOrigin]);
    expect(isAllowedOrigin(ownOrigin, '', appUrl)).toBe(true);
    expect(isAllowedOrigin('https://unlisted.example.test', '', appUrl)).toBe(false);
    const policy = ' https://portal.example.test, http://localhost:5173 ';
    expect(parseAllowedOrigins(policy, appUrl)).toEqual(expect.arrayContaining([ownOrigin, 'https://portal.example.test', 'http://localhost:5173']));
    expect(isAllowedOrigin('https://portal.example.test', policy, appUrl)).toBe(true);
    expect(isAllowedOrigin('https://portal.example.test:444', policy, appUrl)).toBe(false);
    expect(isAllowedOrigin('https://portal.example.test.evil.test', policy, appUrl)).toBe(false);
  });

  it('allows canonical HTTP and HTTPS origins in wildcard mode', () => {
    expect(parseAllowedOrigins('*', appUrl)).toBe('*');
    for (const origin of ['https://first.example.test', 'https://second.example.test:8443', 'http://localhost:5173', 'http://127.0.0.1:12345']) {
      expect(isAllowedOrigin(origin, '*', appUrl)).toBe(true);
    }
  });

  it('rejects opaque, malformed and noncanonical request origins even in wildcard mode', () => {
    for (const origin of ['null', '*', 'not-a-url', 'file:///tmp/page.html', 'ftp://example.test', 'https://example.test/', 'https://example.test/path', 'https://example.test?query=1', 'https://example.test#fragment', 'https://user:password@example.test', 'https://EXAMPLE.test', 'https://one.test https://two.test']) {
      expect(isAllowedOrigin(origin, '*', appUrl), origin).toBe(false);
    }
  });

  it('rejects invalid allowlist entries during configuration validation', () => {
    for (const policy of ['null', 'https://example.test/path', 'https://example.test?query=1', 'https://example.test#fragment', 'https://user:password@example.test', 'https://example.test/', 'ftp://example.test', 'https://EXAMPLE.test', '*,https://example.test']) {
      expect(() => parseAllowedOrigins(policy, appUrl), policy).toThrow();
      config.allowedOrigins = policy;
      expect(() => validateConfig(), policy).toThrow();
    }
    config.allowedOrigins = '*';
    expect(() => validateConfig()).not.toThrow();
  });
});

describe('API CORS and authenticated writes', () => {
  it('rejects an unlisted origin by default before loading a session', async () => {
    const { app, sessions } = fixture();
    const response = await request(app).post('/api/resource').set('Origin', 'https://unlisted.example.test').set('x-csrf-token', csrfToken).send({});
    expect(response.status).toBe(403); expect(sessions).not.toHaveBeenCalled();
    expect(response.headers['access-control-allow-origin']).toBeUndefined(); expectOriginVary(response);
  });

  it('uses exact origin responses for the default and CSV policy without credential sharing', async () => {
    config.allowedOrigins = 'https://portal.example.test';
    const { app } = fixture();
    for (const origin of [ownOrigin, 'https://portal.example.test']) {
      const response = await request(app).get('/api/resource').set('Origin', origin);
      expect(response.status).toBe(200); expect(response.headers['access-control-allow-origin']).toBe(origin);
      expect(response.headers['access-control-allow-credentials']).toBeUndefined(); expectOriginVary(response);
    }
    const preflight = await request(app).options('/api/resource').set('Origin', 'https://portal.example.test').set('Access-Control-Request-Method', 'PATCH');
    expect(preflight.status).toBe(204); expect(preflight.headers['access-control-allow-origin']).toBe('https://portal.example.test');
    expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
    const response = await request(app).get('/api/resource');
    expect(response.status).toBe(200); expect(response.headers['access-control-allow-origin']).toBeUndefined(); expectOriginVary(response);
  });

  it('accepts multiple wildcard origins while keeping CSRF verification on writes', async () => {
    config.allowedOrigins = '*';
    const { app } = fixture();
    for (const origin of ['https://first.example.test', 'http://localhost:4173']) {
      const response = await request(app).post('/api/resource').set('Origin', origin).set('x-csrf-token', csrfToken).send({});
      expect(response.status).toBe(200); expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.headers['access-control-allow-credentials']).toBeUndefined(); expectOriginVary(response);
    }
    expect((await request(app).post('/api/resource').set('Origin', 'https://first.example.test').send({})).status).toBe(403);
    expect((await request(app).post('/api/resource').set('Origin', 'https://first.example.test').set('x-csrf-token', 'b'.repeat(64)).send({})).status).toBe(403);
  });

  it('requires authentication even with an allowed origin and a valid CSRF cookie/token', async () => {
    config.allowedOrigins = '*';
    const { app } = fixture(false);
    const response = await request(app).post('/api/resource').set('Origin', 'https://allowed.example.test').set('Cookie', `sdwe_csrf=${csrfToken}`).set('x-csrf-token', csrfToken).send({});
    expect(response.status).toBe(401); expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('rejects malformed request origins in wildcard mode before session loading', async () => {
    config.allowedOrigins = '*';
    const { app, sessions } = fixture();
    for (const origin of ['null', 'https://example.test/', 'https://user:password@example.test', 'https://example.test/path', 'https://example.test?query=1', 'https://EXAMPLE.test']) {
      const response = await request(app).get('/api/resource').set('Origin', origin);
      expect(response.status, origin).toBe(403); expectOriginVary(response);
    }
    expect(sessions).not.toHaveBeenCalled();
  });

  it('answers valid preflight before session loading and advertises only supported methods and headers', async () => {
    config.allowedOrigins = '*';
    const { app, sessions } = fixture();
    const response = await request(app).options('/api/resource').set('Origin', 'https://frontend.example.test').set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type, x-csrf-token');
    expect(response.status).toBe(204); expect(response.text).toBe(''); expect(sessions).not.toHaveBeenCalled();
    expect(response.headers['access-control-allow-origin']).toBe('*'); expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(response.headers['access-control-allow-methods'].split(/\s*,\s*/).sort()).toEqual(['GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST']);
    expect(response.headers['access-control-allow-headers'].toLowerCase().split(/\s*,\s*/).sort()).toEqual(['content-type', 'x-csrf-token']);
    expectOriginVary(response);
  });

  it('rejects invalid preflight origins, methods and headers before session loading', async () => {
    config.allowedOrigins = '*';
    const { app, sessions } = fixture();
    for (const headers of [
      { Origin: 'null', 'Access-Control-Request-Method': 'POST' },
      { Origin: 'https://frontend.example.test', 'Access-Control-Request-Method': 'DELETE' },
      { Origin: 'https://frontend.example.test' },
      { Origin: 'https://frontend.example.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization' },
      { Origin: 'https://frontend.example.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, x-unapproved' },
    ]) {
      const response = await request(app).options('/api/resource').set(headers);
      expect(response.status, JSON.stringify(headers)).toBe(403); expectOriginVary(response);
    }
    expect(sessions).not.toHaveBeenCalled();
  });

  it('passes ordinary OPTIONS without an Origin through to the application', async () => {
    const { app, sessions } = fixture();
    const response = await request(app).options('/api/resource');
    expect(response.status).toBe(200); expect(response.body).toEqual({ reachedApplication: true });
    expect(sessions).toHaveBeenCalledOnce(); expect(response.headers['access-control-allow-origin']).toBeUndefined(); expectOriginVary(response);
  });
});
