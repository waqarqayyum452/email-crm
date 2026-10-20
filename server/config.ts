import 'dotenv/config';
import { parseAllowedOrigins } from './lib/origins.js';

const production = process.env.NODE_ENV === 'production';
export const config = {
  production,
  port: Number(process.env.PORT || 3000),
  appUrl: process.env.APP_URL || 'http://localhost:5173',
  allowedOrigins: process.env.ALLOWED_ORIGINS || '',
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  schedulerSecret: process.env.SCHEDULER_SECRET || '',
  liveSendEnabled: process.env.LIVE_SEND_ENABLED === 'true',
  sessionHours: 12,
  trustProxy: Number(process.env.TRUST_PROXY_HOPS || 0),
};
export function validateConfig() {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid PORT');
  const url = new URL(config.appUrl);
  parseAllowedOrigins(config.allowedOrigins,config.appUrl);
  if (production && url.protocol !== 'https:') throw new Error('Production APP_URL must use HTTPS');
  if (Buffer.from(config.encryptionKey, 'base64').length !== 32) throw new Error('ENCRYPTION_KEY must be a base64-encoded random 32-byte key');
  if (config.schedulerSecret.length < 32) throw new Error('SCHEDULER_SECRET must contain at least 32 random characters');
}
