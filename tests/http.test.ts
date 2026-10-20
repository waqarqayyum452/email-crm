import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { z } from 'zod';

vi.mock('dotenv/config', () => ({}));
vi.mock('../server/db.js', () => ({ db: vi.fn(() => { throw new Error('HTTP unit tests must not query a database'); }) }));
import { HttpResponse, parseBody, requestContext, Router, runHandlers, errorResponse } from '../server/http.js';
import { HttpError } from '../server/lib/util.js';
import { httpFixture } from './http-fixture.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('native HTTP dispatcher boundaries', () => {
  it('decodes route parameters and requires literal suffixes and mount boundaries', async () => {
    const router = Router();
    router.get('/open/:token.gif', (req, res) => res.json({ token: req.params.token }));
    const res = new HttpResponse(), req = requestContext(new Request('https://crm.test/t/open/space%20and%2Bplus.gif'));
    expect(await router.dispatch(req, res, '/t')).toBe(true);
    expect(await res.toResponse().json()).toEqual({ token: 'space and+plus' });
    for (const path of ['/tracking/open/value.gif', '/t/open/valueXgif', '/t/open/value.gif/extra']) {
      expect(await router.dispatch(requestContext(new Request('https://crm.test' + path)), new HttpResponse(), '/t'), path).toBe(false);
    }
  });

  it('rejects malformed path escapes before calling the domain handler', async () => {
    const router = Router(), handler = vi.fn(); router.get('/:id', handler);
    await expect(router.dispatch(requestContext(new Request('https://crm.test/%ZZ')), new HttpResponse())).rejects.toMatchObject({ status: 400 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('retains repeated query parameters and treats prototype-like names as ordinary input', () => {
    const req = requestContext(new Request('https://crm.test/api?tag=a&tag=b&__proto__=value&single=one', { headers: { 'X-Example': 'case-insensitive' } }), '127.0.0.8');
    expect(req.query.tag).toEqual(['a', 'b']); expect(req.query.single).toBe('one'); expect(req.query.__proto__).toBe('value');
    expect(Object.getPrototypeOf(req.query)).toBeNull(); expect(req.get('X-EXAMPLE')).toBe('case-insensitive'); expect(req.ip).toBe('127.0.0.8');
  });

  it('rejects malformed or scalar JSON without revealing request contents', async () => {
    for (const body of ['{"private-password":', '"private-password"', 'null', '42']) {
      const web = new Request('https://crm.test/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      await expect(parseBody(web, requestContext(web), 1024)).rejects.toMatchObject({ status: 400, message: 'Invalid JSON request.' });
    }
    const web = new Request('https://crm.test/api', { method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: '{"name":"Valid"}' }), req = requestContext(web);
    await parseBody(web, req, 1024); expect(req.body).toEqual({ name: 'Valid' });
  });

  it('enforces declared and streamed byte limits before parsing a request body', async () => {
    const declared = new Request('https://crm.test/api', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '1000' }, body: '{}' });
    await expect(parseBody(declared, requestContext(declared), 32)).rejects.toMatchObject({ status: 413 });
    const cancelled = vi.fn(), chunks = [new Uint8Array(20), new Uint8Array(20), new Uint8Array(20), new Uint8Array(20)];
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { const chunk = chunks.shift(); if (chunk) controller.enqueue(chunk); else controller.close(); }, cancel: cancelled });
    const streamed = new Request('https://crm.test/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
    await expect(parseBody(streamed, requestContext(streamed), 32)).rejects.toMatchObject({ status: 413 });
    expect(cancelled).toHaveBeenCalledOnce();
    const unicode = new Request('https://crm.test/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"v":"😀😀"}' });
    await expect(parseBody(unicode, requestContext(unicode), 12)).rejects.toMatchObject({ status: 413 });
  });

  it('rejects compressed bodies and parses bounded one-click unsubscribe forms', async () => {
    const compressed = new Request('https://crm.test/api', { method: 'POST', headers: { 'Content-Encoding': 'gzip', 'Content-Type': 'application/json' }, body: '{}' });
    await expect(parseBody(compressed, requestContext(compressed), 1024)).rejects.toMatchObject({ status: 415 });
    const web = new Request('https://crm.test/unsubscribe/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click&tag=one&tag=two&__proto__=safe' }), req = requestContext(web);
    await parseBody(web, req, 4096, 'form');
    expect(req.body['List-Unsubscribe']).toBe('One-Click'); expect(req.body.tag).toEqual(['one', 'two']); expect(req.body.__proto__).toBe('safe'); expect(Object.getPrototypeOf(req.body)).toBeNull();
  });

  it('preserves separate Set-Cookie headers and returns HEAD metadata with an empty body', async () => {
    const router = Router();
    router.get('/cookies', (_req, res) => res.append('Set-Cookie', 'session=fixture; Path=/; HttpOnly; SameSite=Strict').append('Set-Cookie', 'csrf=fixture; Path=/; HttpOnly; SameSite=Strict').json({ ok: true }));
    const app = httpFixture({ mounts: [[router]] }), get = await request(app).get('/cookies'), head = await request(app).head('/cookies');
    expect(get.status).toBe(200); expect(get.headers['set-cookie']).toHaveLength(2); expect(get.headers['set-cookie'][0]).toContain('session=fixture'); expect(get.headers['set-cookie'][1]).toContain('csrf=fixture');
    expect(head.status).toBe(200); expect(head.headers['content-type']).toContain('application/json'); expect(head.text).toBeUndefined();
  });

  it('stops middleware after a denial and detects duplicate continuation', async () => {
    const afterDenial = vi.fn(), req = requestContext(new Request('https://crm.test/api'));
    await runHandlers([(_req, res) => res.status(403).json({ error: 'Denied' }), afterDenial], req, new HttpResponse()); expect(afterDenial).not.toHaveBeenCalled();
    await expect(runHandlers([(_req, _res, next) => { next(); next(); }], req, new HttpResponse())).rejects.toThrow('continued twice');
  });

  it('maps expected errors while keeping SQL, bindings and credentials out of responses and logs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = Object.assign(new Error('SELECT password=private-password FROM private_table'), { sql: 'private SQL bindings', password: 'private-password' }), response = new HttpResponse();
    errorResponse(raw, response); expect(response.statusCode).toBe(500);
    const combined = await response.toResponse().text() + JSON.stringify(log.mock.calls);
    expect(combined).not.toMatch(/private-password|private_table|private SQL bindings/); expect(combined).toContain('request_failed');
    const duplicate = new HttpResponse(); errorResponse({ code: 'ER_DUP_ENTRY', sql: 'private SQL' }, duplicate); expect(duplicate.statusCode).toBe(409);
    const expected = new HttpResponse(); errorResponse(new HttpError(403, 'Permission denied'), expected); expect(expected.statusCode).toBe(403); expect(await expected.toResponse().json()).toEqual({ error: 'Permission denied' });
    const validation = z.object({ email: z.string().email() }).safeParse({ email: 'invalid' });
    if (validation.success) throw new Error('Fixture must fail validation');
    const invalid = new HttpResponse(); errorResponse(validation.error, invalid); expect(invalid.statusCode).toBe(400);
  });
});
