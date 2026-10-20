import { errorResponse, HttpResponse, nodeHandler, parseBody, requestContext, runHandlers, type DomainRouter, type Handler } from '../server/http.js';

/** Exercise the same dispatcher as Next Route Handlers through Supertest's Node adapter. */
export function httpFixture(options: {
  beforeBody?: Handler[];
  middleware?: Handler[];
  mounts: [DomainRouter, string?][];
  fallback?: Handler;
}) {
  return nodeHandler(async (web, context) => {
    const req = requestContext(web, context?.remoteAddress), res = new HttpResponse();
    try {
      await runHandlers(options.beforeBody || [], req, res);
      if (!res.headersSent) await parseBody(web, req, 2200 * 1024, req.path.startsWith('/unsubscribe/') ? 'form' : 'json');
      if (!res.headersSent) await runHandlers(options.middleware || [], req, res);
      if (!res.headersSent) {
        for (const [router, prefix] of options.mounts) if (await router.dispatch(req, res, prefix)) break;
      }
      if (!res.headersSent && options.fallback) await runHandlers([options.fallback], req, res);
      if (!res.headersSent) res.status(404).json({ error: 'Test route not found.' });
    } catch (error) { errorResponse(error, res); }
    return res.toResponse(web.method);
  });
}
