import fs from 'fs';
import path from 'path';
import pg from 'pg';
import dotenv from 'dotenv';

import { getDatabaseConnectionConfig } from './client';

dotenv.config();

const { Pool } = pg;

export async function runMigrations(databaseUrl?: string): Promise<{ success: boolean; applied: string[]; errors?: any }> {
  let poolConfig: any;
  if (databaseUrl) {
    const isSsl = databaseUrl.includes('supabase.co') || databaseUrl.includes('sslmode=require');
    poolConfig = {
      connectionString: databaseUrl,
      ssl: isSsl ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 5000,
    };
  } else {
    poolConfig = getDatabaseConnectionConfig();
  }

  const pool = new Pool(poolConfig);
  const applied: string[] = [];

  try {
    const client = await pool.connect();
    try {
      // 1. Ensure migrations tracking table exists
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version VARCHAR(255) PRIMARY KEY,
          applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 2. Read migration files
      const migrationsDir = path.resolve('migrations');
      if (!fs.existsSync(migrationsDir)) {
        return { success: true, applied: [] };
      }

      const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

      for (const file of files) {
        const { rows } = await client.query('SELECT version FROM schema_migrations WHERE version = $1', [file]);
        if (rows.length === 0) {
          console.log(`[Migrator] Applying migration: ${file}...`);
          const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
          await client.query('BEGIN');
          try {
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
            await client.query('COMMIT');
            applied.push(file);
            console.log(`[Migrator] Successfully applied ${file}`);
          } catch (mErr) {
            await client.query('ROLLBACK');
            console.error(`[Migrator] Failed to apply ${file}:`, mErr);
            throw mErr;
          }
        }
      }

      return { success: true, applied };
    } finally {
      client.release();
      await pool.end();
    }
  } catch (err) {
    console.warn('[Migrator] Migrations execution caught error (database might be unreachable or remote):', err);
    return { success: false, applied, errors: err };
  }
}
