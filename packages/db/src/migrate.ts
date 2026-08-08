import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './client.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const { db, pool } = createDatabase(databaseUrl);
try {
  await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
  console.log('Database migrations complete.');
} finally {
  await pool.end();
}
