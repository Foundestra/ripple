import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Apply additive migrations only. There is deliberately no destructive down runner.
export async function migratePlatform(pool, directory = new URL('../../../migrations/platform/', import.meta.url)) {
  const files = (await readdir(directory)).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  const migrations = await Promise.all(files.map(async name => {
    const sql = await readFile(new URL(name, directory), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ripple-platform-migrations'))");
    await client.query('CREATE TABLE IF NOT EXISTS platform_schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const migration of migrations) {
      const prior = await client.query('SELECT checksum FROM platform_schema_migrations WHERE version=$1', [migration.name]);
      if (prior.rows.length) {
        if (prior.rows[0].checksum !== migration.checksum) throw new Error('Platform migration checksum conflict');
        continue;
      }
      await client.query(migration.sql);
      await client.query('INSERT INTO platform_schema_migrations(version,checksum) VALUES($1,$2)', [migration.name, migration.checksum]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
