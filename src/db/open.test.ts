import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite } from './open.js';

describe('openSqlite', () => {
  const tmpDirs: string[] = [];

  function makeTmpDb(): string {
    const dir = mkdtempSync(join(tmpdir(), 'alduin-db-'));
    tmpDirs.push(dir);
    return join(dir, 'test.db');
  }

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('sets journal_mode to WAL for file-backed databases', () => {
    const dbPath = makeTmpDb();
    const db = openSqlite(dbPath);

    const mode = db.pragma('journal_mode', { simple: true }) as string;
    expect(mode).toBe('wal');

    db.close();
  });

  it('sets busy_timeout to 5000 ms', () => {
    const dbPath = makeTmpDb();
    const db = openSqlite(dbPath);

    const timeout = db.pragma('busy_timeout', { simple: true }) as number;
    expect(timeout).toBe(5000);

    db.close();
  });

  it('accepts :memory: without throwing (WAL is silently kept as memory mode)', () => {
    const db = openSqlite(':memory:');
    // SQLite keeps :memory: databases in "memory" journal mode — not wal.
    // The important thing is that the call does not throw.
    const mode = db.pragma('journal_mode', { simple: true }) as string;
    expect(['memory', 'wal']).toContain(mode);
    db.close();
  });

  it('two handles to the same WAL database can write without deadlocking', () => {
    const dbPath = makeTmpDb();

    const db1 = openSqlite(dbPath);
    const db2 = openSqlite(dbPath);

    db1.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, val TEXT)`);

    // Write from handle 1
    db1.prepare(`INSERT OR REPLACE INTO kv VALUES ('h1', 'from-handle-1')`).run();

    // Write from handle 2
    db2.prepare(`INSERT OR REPLACE INTO kv VALUES ('h2', 'from-handle-2')`).run();

    // Both writes must be visible to either handle
    const row1 = db1.prepare<[], { key: string; val: string }>(
      `SELECT * FROM kv WHERE key = 'h2'`
    ).get();
    expect(row1?.val).toBe('from-handle-2');

    const row2 = db2.prepare<[], { key: string; val: string }>(
      `SELECT * FROM kv WHERE key = 'h1'`
    ).get();
    expect(row2?.val).toBe('from-handle-1');

    db1.close();
    db2.close();
  });

  it('each call returns an independent handle', () => {
    const dbPath = makeTmpDb();
    const db1 = openSqlite(dbPath);
    const db2 = openSqlite(dbPath);

    expect(db1).not.toBe(db2);

    db1.close();
    db2.close();
  });
});
