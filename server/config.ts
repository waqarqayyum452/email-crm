import 'dotenv/config';
import { parseAllowedOrigins } from './lib/origins.js';

// Keep operator settings at runtime rather than capturing them in a Next build.
const env=process.env;
const production = env.NODE_ENV === 'production';
export const config = {
  production,
  port: Number(env.PORT || 3000),
  appUrl: env.APP_URL || 'http://localhost:3000',
  allowedOrigins: env.ALLOWED_ORIGINS || '',
  encryptionKey: env.ENCRYPTION_KEY || '',
  schedulerSecret: env.SCHEDULER_SECRET || '',
  liveSendEnabled: env.LIVE_SEND_ENABLED === 'true',
  sessionHours: 12,
  trustProxy: Number(env.TRUST_PROXY_HOPS || 0),
};
export function validateConfig() {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid PORT');
  if (!Number.isInteger(config.trustProxy) || config.trustProxy < 0) throw new Error('Invalid TRUST_PROXY_HOPS');
  const url = new URL(config.appUrl);
  parseAllowedOrigins(config.allowedOrigins,config.appUrl);
  if (production && url.protocol !== 'https:') throw new Error('Production APP_URL must use HTTPS');
  if (Buffer.from(config.encryptionKey, 'base64').length !== 32) throw new Error('ENCRYPTION_KEY must be a base64-encoded random 32-byte key');
  if (config.schedulerSecret.length < 32) throw new Error('SCHEDULER_SECRET must contain at least 32 random characters');
}
