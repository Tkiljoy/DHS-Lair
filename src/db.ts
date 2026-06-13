import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_DIR = path.resolve(__dirname, '..', 'store');
const DB_PATH = path.join(STORE_DIR, 'dhs.db');

if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  const conn = new Database(DB_PATH);
  conn.pragma('journal_mode = WAL');
  conn.pragma('busy_timeout = 5000');
  conn.pragma('foreign_keys = ON');
  _db = conn;
  return conn;
}

export function dbPath(): string {
  return DB_PATH;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function nowMs(): number {
  return Date.now();
}
