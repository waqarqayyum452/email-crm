import 'dotenv/config';
import knex, { type Knex } from 'knex';

const createDatabase = () => knex({
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
// Next development reloads route modules. Reuse the pool rather than leaking one
// per reload; isolated test modules deliberately own and destroy their own pool.
const runtimeEnv=process.env;
const processState=globalThis as typeof globalThis & {emailCrmDatabase?:Knex};
export const db=runtimeEnv.NODE_ENV==='test'?createDatabase():(processState.emailCrmDatabase??=createDatabase());
export type Database = Knex | Knex.Transaction;
export function json<T = any>(value: unknown, fallback: unknown = {}): T {
  if (value == null) return fallback as T;
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value === 'string') { try { return JSON.parse(value) as T; } catch { return fallback as T; } }
  return value as T;
}
