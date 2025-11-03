
import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';

sqlite3.verbose();

export type DB = sqlite3.Database;

export async function openDb(dbPath: string): Promise<DB> {
  await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });
  return new Promise((res, rej) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, err => {
      if (err) rej(err);
      else res(db);
    });
  });
}

export function run(db: DB, sql: string, params: any[] = []): Promise<void> {
  return new Promise((res, rej) => db.run(sql, params, err => err ? rej(err) : res()));
}

export function get<T = any>(db: DB, sql: string, params: any[] = []): Promise<T | undefined> {
  return new Promise((res, rej) => db.get(sql, params, (err, row) => err ? rej(err) : res(row as T | undefined)));
}

export function all<T = any>(db: DB, sql: string, params: any[] = []): Promise<T[]> {
  return new Promise((res, rej) => db.all(sql, params, (err, rows) => err ? rej(err) : res(rows as unknown as T[])));
}

export async function tx<T>(db: DB, fn: () => Promise<T>): Promise<T> {
  await run(db, 'BEGIN IMMEDIATE');
  try {
    const out = await fn();
    await run(db, 'COMMIT');
    return out;
  } catch (e) {
    try { await run(db, 'ROLLBACK'); } catch {}
    throw e;
  }
}

export async function pragmas(db: DB) {
  await run(db, 'PRAGMA journal_mode=WAL');
  await run(db, 'PRAGMA busy_timeout=5000');
  await run(db, 'PRAGMA foreign_keys=ON');
}

export async function migrate(db: DB) {
  await tx(db, async () => {
    await run(db, `CREATE TABLE IF NOT EXISTS accounts(
      id TEXT PRIMARY KEY,
      google_user_id TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT,
      scopes_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);

    await run(db, `CREATE TABLE IF NOT EXISTS credentials(
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      refresh_token TEXT,
      refresh_token_ct BLOB,
      refresh_token_iv BLOB,
      refresh_token_tag BLOB,
      access_token TEXT,
      access_expires_at INTEGER,
      token_version INTEGER NOT NULL DEFAULT 1
    )`);

    await run(db, `CREATE TABLE IF NOT EXISTS encryption_meta(
      id INTEGER PRIMARY KEY CHECK (id=1),
      is_locked INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      kdf TEXT NOT NULL DEFAULT 'scrypt',
      kdf_salt BLOB,
      kdf_params_json TEXT,
      dek_ct BLOB,
      dek_iv BLOB,
      dek_tag BLOB,
      password_hint TEXT
    )`);

    await run(db, `CREATE TABLE IF NOT EXISTS settings(
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);

    const em = await get(db, 'SELECT * FROM encryption_meta WHERE id=1');
    if (!em) {
      await run(db, 'INSERT INTO encryption_meta(id,is_locked,version,kdf) VALUES(1,0,1,?)', ['scrypt']);
    }
  });
}
