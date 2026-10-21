import 'dotenv/config';
import process from 'node:process';

// No command-line secret or URL token: cron may expose arguments and URLs.
const flags = process.argv.slice(2);
if (flags.includes('--help')) {
  console.log('Usage: node scripts/scheduler-call.mjs [--secret-stdin] [--sync-only|--inbox-only]\nSet SCHEDULER_BASE_URL (or APP_URL) and SCHEDULER_SECRET privately in the environment, or pipe the secret on stdin.');
  process.exit(0);
}
if (flags.some((flag) => !['--secret-stdin','--sync-only','--inbox-only'].includes(flag)) || new Set(flags).size!==flags.length || (flags.includes('--sync-only')&&flags.includes('--inbox-only'))) {
  console.error('Invalid arguments. Use --help. Never supply secrets as arguments.');
  process.exit(2);
}

const started = Date.now();
try {
  const endpoint = new URL('/internal/tick', process.env.SCHEDULER_BASE_URL || process.env.APP_URL || 'http://localhost:3000');
  if (endpoint.username || endpoint.password || !['https:', 'http:'].includes(endpoint.protocol)) throw new Error('CONFIG');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !local) throw new Error('HTTPS_REQUIRED');
  let secret = process.env.SCHEDULER_SECRET || '';
  if (flags.includes('--secret-stdin')) {
    if (process.stdin.isTTY) throw new Error('PIPE_REQUIRED');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 4096) throw new Error('SECRET_INVALID');
      chunks.push(chunk);
    }
    secret = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  if (secret.length < 32 || /[\r\n]/.test(secret)) throw new Error('SECRET_INVALID');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({mode:flags.includes('--sync-only')?'sync':flags.includes('--inbox-only')?'inbox':'all'}),
    redirect: 'manual',
    signal: AbortSignal.timeout(25_000),
  });
  // Do not print the body, URL, headers, or credentials, even on errors.
  await response.body?.cancel();
  console.log(JSON.stringify({ ok: response.ok, http_status: response.status, duration_ms: Date.now() - started }));
  process.exitCode = response.ok ? 0 : 1;
} catch (error) {
  const allowed = new Set(['CONFIG', 'HTTPS_REQUIRED', 'PIPE_REQUIRED', 'SECRET_INVALID']);
  const reason = allowed.has(error?.message) ? error.message : error?.name === 'TimeoutError' ? 'TIMEOUT' : 'REQUEST_FAILED';
  console.error(JSON.stringify({ ok: false, reason, duration_ms: Date.now() - started }));
  process.exitCode = 1;
}
