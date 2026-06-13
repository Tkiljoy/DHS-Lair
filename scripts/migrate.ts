import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, dbPath } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

function ensureMigrationsTable(): void {
  db().exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      filename  TEXT UNIQUE NOT NULL,
      applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
  `);
}

function appliedMigrations(): Set<string> {
  const rows = db().prepare(`SELECT filename FROM _migrations`).all() as { filename: string }[];
  return new Set(rows.map(r => r.filename));
}

async function main(): Promise<void> {
  console.log(`[migrate] db at ${dbPath()}`);
  ensureMigrationsTable();
  const applied = appliedMigrations();
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (applied.has(f)) {
      console.log(`[migrate] skip ${f} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    console.log(`[migrate] applying ${f}`);
    const tx = db().transaction(() => {
      db().exec(sql);
      db().prepare(`INSERT INTO _migrations (filename) VALUES (?)`).run(f);
    });
    tx();
  }
  console.log('[migrate] done.');
}

main().catch(err => {
  console.error('migrate failed:', err);
  process.exit(1);
});
