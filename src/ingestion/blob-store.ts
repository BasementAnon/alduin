import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openSqlite } from '../db/open.js';
import { v4 as uuidv4 } from 'uuid';
import type { AttachmentRef } from '../channels/adapter.js';

interface AttachmentRow {
  attachment_id: string;
  kind: string;
  mime: string;
  bytes: number;
  storage_uri: string;
  enrichment: string | null;
  ttl_expires_at: string;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS attachments (
  attachment_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  storage_uri TEXT NOT NULL,
  enrichment TEXT,
  ttl_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_ttl ON attachments(ttl_expires_at);
`;

/** Allowed extension pattern: empty string OR a dot followed by 1–8 lowercase alphanumerics */
const SAFE_EXT_RE = /^(?:|\.([a-z0-9]{1,8}))$/;

/**
 * Return a filesystem-safe extension for a MIME type.
 * Returns '' (no extension) for unknown MIME types.
 * Throws if the built-in mapping ever produces an unsafe value —
 * this is a defence-in-depth assertion, not just a review comment.
 */
function extForMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'video/mp4': '.mp4',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
  };
  const ext = map[mime] ?? '';

  if (!SAFE_EXT_RE.test(ext)) {
    throw new Error(
      `extForMime produced an unsafe extension ${JSON.stringify(ext)} for MIME ${JSON.stringify(mime)}. ` +
      'Extensions must match /^\\.[a-z0-9]{1,8}$/ or be empty.'
    );
  }

  return ext;
}

/**
 * Local blob store under .alduin/blobs/<yyyy>/<mm>/<dd>/<uuid><ext>.
 * Metadata is persisted in a sidecar SQLite table.
 * A background sweep runs every 5 minutes to delete expired blobs.
 */
export class BlobStore {
  private db: Database.Database;
  private blobsDir: string;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dbPath: string, blobsDir: string) {
    mkdirSync(blobsDir, { recursive: true });
    this.blobsDir = blobsDir;
    this.db = openSqlite(dbPath);
    this.db.exec(SCHEMA);
    this.startSweep();
  }

  /**
   * Save a buffer as a blob. Returns the completed AttachmentRef.
   * @param buffer  - Raw file bytes
   * @param kind    - Semantic kind
   * @param mime    - Detected MIME type
   * @param ttlHours - TTL before deletion (default 24h)
   */
  save(
    buffer: Buffer,
    kind: AttachmentRef['kind'],
    mime: string,
    ttlHours = 24
  ): AttachmentRef {
    const now = new Date();
    const yyyy = now.getUTCFullYear().toString();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const attachmentId = uuidv4();
    const ext = extForMime(mime);

    const dir = join(this.blobsDir, yyyy, mm, dd);
    mkdirSync(dir, { recursive: true });

    const filePath = join(dir, `${attachmentId}${ext}`);
    writeFileSync(filePath, buffer);

    const ttlExpiresAt = new Date(now.getTime() + ttlHours * 3600 * 1000).toISOString();
    const createdAt = now.toISOString();

    this.db
      .prepare(
        `INSERT INTO attachments
          (attachment_id, kind, mime, bytes, storage_uri, enrichment, ttl_expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(attachmentId, kind, mime, buffer.length, filePath, ttlExpiresAt, createdAt);

    return {
      attachment_id: attachmentId,
      kind,
      mime,
      bytes: buffer.length,
      storage_uri: filePath,
      ttl_expires_at: ttlExpiresAt,
    };
  }

  /** Update the enrichment JSON for a stored attachment */
  updateEnrichment(
    attachmentId: string,
    enrichment: AttachmentRef['enrichment']
  ): void {
    this.db
      .prepare('UPDATE attachments SET enrichment = ? WHERE attachment_id = ?')
      .run(JSON.stringify(enrichment), attachmentId);
  }

  /** Look up an attachment by ID */
  findById(attachmentId: string): AttachmentRef | null {
    const row = this.db
      .prepare<[string], AttachmentRow>(
        'SELECT * FROM attachments WHERE attachment_id = ?'
      )
      .get(attachmentId);

    if (!row) return null;
    return rowToRef(row);
  }

  /** Delete a blob by ID (file + DB row) */
  delete(attachmentId: string): void {
    const row = this.db
      .prepare<[string], AttachmentRow>(
        'SELECT storage_uri FROM attachments WHERE attachment_id = ?'
      )
      .get(attachmentId);

    if (row) {
      if (existsSync(row.storage_uri)) {
        try { unlinkSync(row.storage_uri); } catch { /* already gone */ }
      }
      this.db
        .prepare('DELETE FROM attachments WHERE attachment_id = ?')
        .run(attachmentId);
    }
  }

  /**
   * Delete all expired blobs. Returns the number of entries removed.
   * Called automatically every 5 minutes; also callable on demand.
   */
  sweepExpired(): number {
    const now = new Date().toISOString();
    const expired = this.db
      .prepare<[string], AttachmentRow>(
        'SELECT * FROM attachments WHERE ttl_expires_at <= ?'
      )
      .all(now);

    let deleted = 0;
    for (const row of expired) {
      if (existsSync(row.storage_uri)) {
        try { unlinkSync(row.storage_uri); } catch { /* already gone */ }
      }
      this.db
        .prepare('DELETE FROM attachments WHERE attachment_id = ?')
        .run(row.attachment_id);
      deleted++;
    }
    return deleted;
  }

  close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.db.close();
  }

  private startSweep(): void {
    // Run sweep every 5 minutes; unref so it doesn't keep the process alive
    this.sweepTimer = setInterval(() => this.sweepExpired(), 5 * 60 * 1000);
    this.sweepTimer.unref?.();
  }
}

function rowToRef(row: AttachmentRow): AttachmentRef {
  return {
    attachment_id: row.attachment_id,
    kind: row.kind as AttachmentRef['kind'],
    mime: row.mime,
    bytes: row.bytes,
    storage_uri: row.storage_uri,
    enrichment: row.enrichment
      ? (JSON.parse(row.enrichment) as AttachmentRef['enrichment'])
      : undefined,
    ttl_expires_at: row.ttl_expires_at,
  };
}
