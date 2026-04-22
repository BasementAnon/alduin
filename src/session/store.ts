import Database from 'better-sqlite3';
import { openSqlite } from '../db/open.js';
import type { Session, PolicyOverrides } from './types.js';

/** Row shape as stored in SQLite (JSON columns are strings) */
interface SessionRow {
  session_id: string;
  channel: string;
  external_thread_id: string;
  external_user_ids: string; // JSON
  group_session_id: string | null;
  tenant_id: string;
  created_at: string;
  last_active_at: string;
  policy_overrides: string | null; // JSON
}

function rowToSession(row: SessionRow): Session {
  return {
    session_id: row.session_id,
    channel: row.channel,
    external_thread_id: row.external_thread_id,
    external_user_ids: JSON.parse(row.external_user_ids) as string[],
    group_session_id: row.group_session_id ?? undefined,
    tenant_id: row.tenant_id,
    created_at: row.created_at,
    last_active_at: row.last_active_at,
    policy_overrides: row.policy_overrides
      ? (JSON.parse(row.policy_overrides) as PolicyOverrides)
      : undefined,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  external_thread_id TEXT NOT NULL,
  external_user_ids TEXT NOT NULL,
  group_session_id TEXT,
  tenant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  policy_overrides TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_channel_thread
  ON sessions(channel, external_thread_id);
`;

/**
 * SQLite-backed session store.
 * Uses better-sqlite3 (synchronous) for local-first operation.
 * Pass ':memory:' as dbPath for tests.
 */
export class SessionStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = openSqlite(dbPath);
    this.db.exec(SCHEMA);
  }

  /** Look up a session by (channel, external_thread_id) */
  findByThread(channel: string, externalThreadId: string): Session | null {
    const row = this.db
      .prepare<[string, string], SessionRow>(
        'SELECT * FROM sessions WHERE channel = ? AND external_thread_id = ?'
      )
      .get(channel, externalThreadId);
    return row ? rowToSession(row) : null;
  }

  /** Look up a session by its primary key */
  findById(sessionId: string): Session | null {
    const row = this.db
      .prepare<[string], SessionRow>('SELECT * FROM sessions WHERE session_id = ?')
      .get(sessionId);
    return row ? rowToSession(row) : null;
  }

  /** Persist a new session */
  create(session: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions
          (session_id, channel, external_thread_id, external_user_ids,
           group_session_id, tenant_id, created_at, last_active_at, policy_overrides)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.session_id,
        session.channel,
        session.external_thread_id,
        JSON.stringify(session.external_user_ids),
        session.group_session_id ?? null,
        session.tenant_id,
        session.created_at,
        session.last_active_at,
        session.policy_overrides ? JSON.stringify(session.policy_overrides) : null
      );
  }

  /** Update last_active_at and optionally add a new user_id */
  touch(sessionId: string, userId: string): void {
    const now = new Date().toISOString();
    const session = this.findById(sessionId);
    if (!session) return;

    const userIds = new Set(session.external_user_ids);
    userIds.add(userId);

    this.db
      .prepare(
        'UPDATE sessions SET last_active_at = ?, external_user_ids = ? WHERE session_id = ?'
      )
      .run(now, JSON.stringify([...userIds]), sessionId);
  }

  /** Replace policy_overrides for a session */
  updatePolicy(sessionId: string, overrides: PolicyOverrides): void {
    this.db
      .prepare('UPDATE sessions SET policy_overrides = ? WHERE session_id = ?')
      .run(JSON.stringify(overrides), sessionId);
  }

  /**
   * Merge partial policy overrides into the session's existing overrides.
   * Creates the overrides object if none existed.
   */
  updatePolicyOverride(sessionId: string, partial: Partial<PolicyOverrides>): void {
    const session = this.findById(sessionId);
    if (!session) return;
    const merged = { ...(session.policy_overrides ?? {}), ...partial };
    this.updatePolicy(sessionId, merged);
  }

  /** Close the database connection */
  close(): void {
    this.db.close();
  }
}
