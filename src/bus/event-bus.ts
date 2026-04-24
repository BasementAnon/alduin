import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { openSqlite } from '../db/open.js';
import { randomUUID } from 'node:crypto';

/** Event kinds emitted by executors during task execution */
export type ExecutorEventKind =
  | 'progress'
  | 'partial'
  | 'needs_input'
  | 'artifact'
  | 'tool_call';

/** An event emitted by an executor during (not after) task execution */
export interface ExecutorEvent {
  task_id: string;
  session_id: string;
  step_index: number;
  kind: ExecutorEventKind;
  data: unknown;
  emitted_at: string;
}

type EventHandler = (event: ExecutorEvent) => void;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  emitted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
`;

/**
 * Typed pub/sub for ExecutorEvents, keyed by session_id.
 *
 * In-process delivery via EventEmitter for low latency.
 * SQLite durability table so subscribers can replay missed events after a crash.
 */
export class AlduinEventBus {
  private emitter = new EventEmitter();
  private db: Database.Database;

  constructor(dbPath = ':memory:') {
    this.db = openSqlite(dbPath);
    this.db.exec(SCHEMA);
    this.emitter.setMaxListeners(100);
  }

  /**
   * Publish an event: persist to SQLite and emit in-process.
   */
  publish(event: ExecutorEvent): void {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO events (id, session_id, task_id, step_index, kind, data, emitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        event.session_id,
        event.task_id,
        event.step_index,
        event.kind,
        JSON.stringify(event.data),
        event.emitted_at
      );

    this.emitter.emit(`session:${event.session_id}`, event);
    this.emitter.emit('*', event);
  }

  /**
   * Subscribe to events for a specific session.
   * Returns an unsubscribe function.
   */
  subscribe(sessionId: string, handler: EventHandler): () => void {
    const key = `session:${sessionId}`;
    this.emitter.on(key, handler);
    return () => this.emitter.off(key, handler);
  }

  /**
   * Subscribe to ALL events across all sessions.
   */
  subscribeAll(handler: EventHandler): () => void {
    this.emitter.on('*', handler);
    return () => this.emitter.off('*', handler);
  }

  /**
   * Replay persisted events for a session (e.g. after a crash recovery).
   * Events are returned in chronological order.
   */
  replay(sessionId: string, afterId?: string): ExecutorEvent[] {
    interface EventRow {
      id: string;
      session_id: string;
      task_id: string;
      step_index: number;
      kind: string;
      data: string;
      emitted_at: string;
    }

    let rows: EventRow[];
    if (afterId) {
      rows = this.db
        .prepare<[string, string], EventRow>(
          'SELECT * FROM events WHERE session_id = ? AND rowid > (SELECT rowid FROM events WHERE id = ?) ORDER BY rowid'
        )
        .all(sessionId, afterId);
    } else {
      rows = this.db
        .prepare<[string], EventRow>(
          'SELECT * FROM events WHERE session_id = ? ORDER BY rowid'
        )
        .all(sessionId);
    }

    return rows.reduce<ExecutorEvent[]>((events, row) => {
      try {
        events.push({
          task_id: row.task_id,
          session_id: row.session_id,
          step_index: row.step_index,
          kind: row.kind as ExecutorEventKind,
          data: JSON.parse(row.data) as unknown,
          emitted_at: row.emitted_at,
        });
      } catch {
        console.warn(`[EventBus] Skipping event with malformed JSON data (session=${row.session_id}, task=${row.task_id})`);
      }
      return events;
    }, []);
  }

  /** Number of persisted events for a session */
  eventCount(sessionId: string): number {
    const row = this.db
      .prepare<[string], { cnt: number }>(
        'SELECT COUNT(*) as cnt FROM events WHERE session_id = ?'
      )
      .get(sessionId);
    return row?.cnt ?? 0;
  }

  close(): void {
    this.db.close();
  }
}
