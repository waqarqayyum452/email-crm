import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';

type Environment = Record<string, string | undefined>;
type InstallCode = 'SCHEDULER_INSTALL_CONFIG' | 'SCHEDULER_INSTALL_UNSAFE_PATH' | 'SCHEDULER_INSTALL_FAILED';

export class SchedulerInstallError extends Error {
  constructor(public readonly code: InstallCode) {
    super(code === 'SCHEDULER_INSTALL_CONFIG' ? 'Private scheduler configuration is invalid.' : code === 'SCHEDULER_INSTALL_UNSAFE_PATH' ? 'Private scheduler path is unsafe.' : 'Private scheduler installation failed.');
    this.name = 'SchedulerInstallError';
  }
}

// This CLI-only caller contains no credentials. Its adjacent configuration is
// written by the authenticated installer, outside public_html and build folders.
const phpCaller = String.raw`<?php
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
ini_set('display_errors', '0');
error_reporting(0);
umask(0077);
$started = microtime(true);
function report_tick($ok, $status, $reason, $processed = null) {
    global $started;
    $result = array('ok' => $ok, 'http_status' => $status, 'timestamp' => gmdate('c'), 'duration_ms' => (int) round((microtime(true) - $started) * 1000));
    if ($reason !== '') { $result['reason'] = $reason; }
    if (is_int($processed) && $processed >= 0) { $result['processed'] = $processed; }
    echo json_encode($result, JSON_UNESCAPED_SLASHES) . PHP_EOL;
    exit($ok ? 0 : 1);
}
function private_file($path) {
    clearstatcache(true, $path);
    $stat = @lstat($path);
    return $stat !== false && !is_link($path) && is_file($path) && $stat['nlink'] === 1 && ($stat['mode'] & 0077) === 0;
}
try {
    if (is_link(__DIR__) || !is_dir(__DIR__) || (@fileperms(__DIR__) & 0077) !== 0) { report_tick(false, 0, 'PRIVATE_PATH_INVALID'); }
    $configPath = __DIR__ . '/scheduler.json';
    if (!private_file($configPath)) { report_tick(false, 0, 'PRIVATE_CONFIG_INVALID'); }
    $raw = @file_get_contents($configPath, false, null, 0, 8193);
    if ($raw === false || strlen($raw) > 8192) { report_tick(false, 0, 'PRIVATE_CONFIG_INVALID'); }
    $config = json_decode($raw, true);
    if (!is_array($config) || !isset($config['endpoint'], $config['secret'], $config['mode']) || !is_string($config['endpoint']) || !is_string($config['secret']) || $config['mode'] !== 'inbox' || strlen($config['secret']) < 32 || strlen($config['secret']) > 4096 || preg_match('/[\r\n]/', $config['secret'])) { report_tick(false, 0, 'PRIVATE_CONFIG_INVALID'); }
    $url = parse_url($config['endpoint']);
    if ($url === false || !isset($url['scheme'], $url['host'], $url['path']) || $url['scheme'] !== 'https' || $url['path'] !== '/internal/tick' || isset($url['user']) || isset($url['pass']) || isset($url['query']) || isset($url['fragment']) || (isset($url['port']) && $url['port'] !== 443)) { report_tick(false, 0, 'PRIVATE_CONFIG_INVALID'); }
    $lockPath = __DIR__ . '/tick.lock';
    if (file_exists($lockPath) || is_link($lockPath)) {
        if (!private_file($lockPath)) { report_tick(false, 0, 'PRIVATE_LOCK_INVALID'); }
    }
    $lock = @fopen($lockPath, 'c');
    if ($lock === false || !@chmod($lockPath, 0600) || !private_file($lockPath)) { report_tick(false, 0, 'PRIVATE_LOCK_INVALID'); }
    if (!@flock($lock, LOCK_EX | LOCK_NB)) { report_tick(true, 0, 'ALREADY_RUNNING'); }
    if (!function_exists('curl_init')) { report_tick(false, 0, 'CURL_UNAVAILABLE'); }
    $body = '';
    $curl = curl_init();
    if ($curl === false) { report_tick(false, 0, 'REQUEST_FAILED'); }
    $configured = curl_setopt_array($curl, array(
        CURLOPT_URL => $config['endpoint'],
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode(array('mode' => 'inbox')),
        CURLOPT_HTTPHEADER => array('Authorization: Bearer ' . $config['secret'], 'Content-Type: application/json', 'Accept: application/json'),
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_MAXREDIRS => 0,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 25,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_HEADER => false,
        CURLOPT_VERBOSE => false,
        CURLOPT_WRITEFUNCTION => function ($handle, $chunk) use (&$body) {
            if (strlen($body) + strlen($chunk) > 16384) { return 0; }
            $body .= $chunk;
            return strlen($chunk);
        }
    ));
    if (!$configured) { curl_close($curl); report_tick(false, 0, 'REQUEST_FAILED'); }
    $received = @curl_exec($curl);
    $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    curl_close($curl);
    if ($received === false) { report_tick(false, $status, 'REQUEST_FAILED'); }
    if ($status < 200 || $status >= 300) { report_tick(false, $status, 'HTTP_ERROR'); }
    $reply = json_decode($body, true);
    if (!is_array($reply) || !isset($reply['processed']) || !is_int($reply['processed']) || $reply['processed'] < 0) { report_tick(false, $status, 'INVALID_RESPONSE'); }
    report_tick(true, $status, '', $reply['processed']);
} catch (Throwable $error) {
    // Never emit the exception, response body, URL, headers or secret.
    report_tick(false, 0, 'TICK_FAILED');
}
`;

function configuration(env: Environment) {
  try {
    if (env.NODE_ENV !== 'production' || !/^u\d{5,16}$/.test(env.HOSTINGER_ACCOUNT || '')) throw new Error();
    const origin = new URL(env.APP_URL || '');
    const hostname = origin.hostname;
    const labels = hostname.split('.');
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port || origin.pathname !== '/' || origin.search || origin.hash || hostname.length > 253 || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || /^\d+(?:\.\d+){3}$/.test(hostname)) throw new Error();
    const parent = `/home/${env.HOSTINGER_ACCOUNT}/domains/${hostname}`;
    const directory = posix.join(parent, '.email-crm-scheduler');
    if (env.HOSTINGER_SCHEDULER_DIR !== directory || !env.SCHEDULER_SECRET || env.SCHEDULER_SECRET.length < 32 || env.SCHEDULER_SECRET.length > 4096 || /[\r\n]/.test(env.SCHEDULER_SECRET)) throw new Error();
    return { parent, directory, endpoint: new URL('/internal/tick', origin).href, secret: env.SCHEDULER_SECRET };
  } catch {
    throw new SchedulerInstallError('SCHEDULER_INSTALL_CONFIG');
  }
}

async function safeDirectory(directory: string) {
  const info = await fs.lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || await fs.realpath(directory) !== directory) throw new SchedulerInstallError('SCHEDULER_INSTALL_UNSAFE_PATH');
}

async function safeFileOrAbsent(filename: string) {
  try {
    const info = await fs.lstat(filename);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new SchedulerInstallError('SCHEDULER_INSTALL_UNSAFE_PATH');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function atomicPrivateFile(directory: string, name: string, contents: string) {
  const filename = posix.join(directory, name);
  const temporary = posix.join(directory, `.${name}.${randomBytes(12).toString('hex')}.tmp`);
  let created = false;
  try {
    await safeDirectory(directory);
    await safeFileOrAbsent(filename);
    const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
    created = true;
    try { await handle.writeFile(contents, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await safeDirectory(directory);
    await safeFileOrAbsent(filename);
    await fs.rename(temporary, filename);
    created = false;
    await fs.chmod(filename, 0o600);
  } finally {
    if (created) await fs.unlink(temporary).catch(() => undefined);
  }
}

/** Only called by the authenticated, fixed scheduler-install action. No request paths or commands are accepted. */
export async function installHostingerScheduler(env: Environment = process.env) {
  const { parent, directory, endpoint, secret } = configuration(env);
  try {
    await safeDirectory(parent);
    try { await fs.mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await safeDirectory(directory);
    await fs.chmod(directory, 0o700);
    for (const name of ['tick.php', 'scheduler.json', 'tick.lock']) await safeFileOrAbsent(posix.join(directory, name));
    await atomicPrivateFile(directory, 'tick.php', phpCaller);
    await atomicPrivateFile(directory, 'scheduler.json', JSON.stringify({ endpoint, secret, mode: 'inbox' }) + '\n');
    return { installed: true as const, cron_command: `/usr/bin/php ${posix.join(directory, 'tick.php')}` };
  } catch (error) {
    if (error instanceof SchedulerInstallError) throw error;
    throw new SchedulerInstallError('SCHEDULER_INSTALL_FAILED');
  }
}
