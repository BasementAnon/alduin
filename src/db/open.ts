import Database from 'better-sqlite3';

/**
 * Open a better-sqlite3 database with WAL journal mode and a generous busy
 * timeout applied as pragmas at connection time.
 *
 * WAL (Write-Ahead Logging) lets read transactions proceed concurrently with
 * the single active writer, which matters when multiple processes or Node.js
 * worker threads share the same file.  For `:memory:` databases SQLite silently
 * keeps the mode as `memory`, which is fine for tests.
 *
 * `busy_timeout = 5000` makes write-contention retries transparent to callers:
 * instead of throwing SQLITE_BUSY immediately, the driver spins for up to 5 s
 * before giving up — enough headroom for transient bursts.
 */
export function openSqlite(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}
