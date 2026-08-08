import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type RwcarDb = ReturnType<typeof createDatabase>['db'];

export type DatabaseSslMode = 'auto' | 'disable' | 'require' | 'verify-full';

export function databaseSsl(databaseUrl: string, configured = process.env.DATABASE_SSL_MODE) {
  const mode = (configured?.trim().toLowerCase() || 'auto') as DatabaseSslMode;
  if (!['auto', 'disable', 'require', 'verify-full'].includes(mode)) {
    throw new Error('DATABASE_SSL_MODE must be auto, disable, require, or verify-full');
  }
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify-full') return { rejectUnauthorized: true };

  const hostname = new URL(databaseUrl).hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.railway.internal')) {
    return false;
  }
  return { rejectUnauthorized: true };
}

export function createDatabase(databaseUrl: string) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: databaseSsl(databaseUrl),
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
