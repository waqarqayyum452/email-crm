import 'dotenv/config';
import knex, { type Knex } from 'knex';

export const db = knex({
  client: 'mysql2',
  connection: {
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'crm', password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'email_crm', timezone: 'Z', charset: 'utf8mb4',
    connectTimeout: 10000, dateStrings: false, multipleStatements: false,
    ...(process.env.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: true, ...(process.env.DB_SSL_CA ? {ca: process.env.DB_SSL_CA.replace(/\\n/g, '\n')} : {}) } } : {}),
  },
  pool: { min: 0, max: Number(process.env.DB_POOL_SIZE || 5), afterCreate(connection: any, done: any) { connection.query("SET time_zone = '+00:00'", (err: unknown) => done(err, connection)); } },
  acquireConnectionTimeout: 10000,
});
export type Database = Knex | Knex.Transaction;
export function json<T = any>(value: unknown, fallback: unknown = {}): T {
  if (value == null) return fallback as T;
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value === 'string') { try { return JSON.parse(value) as T; } catch { return fallback as T; } }
  return value as T;
}
