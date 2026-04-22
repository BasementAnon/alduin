// ─────────────────────────────────────────────────────────────
// Adapted from OpenClaw (MIT, © Peter Steinberger)
//   Origin: src/secrets/vault.ts (handle/scope API pattern)
//   Origin SHA: 778ac4330aa32b9ce4482f0d1a3d4f744ff7f17f
//   Ported: 2026-04-15
// ─────────────────────────────────────────────────────────────

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import Database from 'better-sqlite3';
import { openSqlite } from '../db/open.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const SALT_LEN = 16;

const LEGACY_SALT = 'alduin-vault-salt';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS credentials (
  scope TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL,
  auth_tag BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cred_scope ON credentials(scope);

CREATE TABLE IF NOT EXISTS vault_meta (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL
);
`;

/**
 * A lazy handle to a single vault scope.
 * Calling resolve() fetches and decrypts the secret on demand.
 */
export interface SecretHandle {
  /** The vault scope key this handle points to. */
  readonly scope: string;
  /** Resolve the secret; returns null if the scope is not stored. */
  resolve(): string | null;
  /** True if the scope currently exists in the vault. */
  exists(): boolean;
}

/**
 * Credential vault backed by SQLite with AES-256-GCM encryption at rest.
 *
 * The encryption key is derived from a master secret + a per-install random salt.
 * The salt is stored in `vault_meta(key='salt')` and generated on first open.
 *
 * Existing vault files without a salt row are automatically migrated: all rows
 * are decrypted under the legacy salt, then re-encrypted under the new random
 * salt inside a single transaction.
 */
export class CredentialVault {
  private db: Database.Database;
  private encKey: Buffer;

  constructor(dbPath: string, masterSecret: string) {
    this.db = openSqlite(dbPath);
    this.db.exec(SCHEMA);

    const salt = this.resolveOrMigrateSalt(masterSecret);
    this.encKey = scryptSync(masterSecret, salt, KEY_LEN);
  }

  /**
   * Return a lazy handle for a vault scope.
   * The handle holds no decrypted data — call handle.resolve() to fetch.
   */
  handle(scope: string): SecretHandle {
    const vault = this;
    return {
      scope,
      resolve(): string | null {
        return vault.get(scope);
      },
      exists(): boolean {
        return vault.has(scope);
      },
    };
  }

  /** Store or update a credential at the given scope. */
  set(scope: string, value: string): void {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGORITHM, this.encKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO credentials (scope, ciphertext, iv, auth_tag, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope) DO UPDATE
           SET ciphertext = excluded.ciphertext,
               iv = excluded.iv,
               auth_tag = excluded.auth_tag,
               updated_at = excluded.updated_at`
      )
      .run(scope, encrypted, iv, authTag, now, now);
  }

  /** Retrieve and decrypt a credential. Returns null if not found. */
  get(scope: string): string | null {
    const row = this.db
      .prepare<[string], { ciphertext: Buffer; iv: Buffer; auth_tag: Buffer }>(
        'SELECT ciphertext, iv, auth_tag FROM credentials WHERE scope = ?'
      )
      .get(scope);

    if (!row) return null;

    const decipher = createDecipheriv(ALGORITHM, this.encKey, row.iv);
    decipher.setAuthTag(row.auth_tag);
    const decrypted = Buffer.concat([
      decipher.update(row.ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  /** Delete a credential. */
  delete(scope: string): void {
    this.db.prepare('DELETE FROM credentials WHERE scope = ?').run(scope);
  }

  /** List all scopes matching a prefix. */
  list(scopePrefix: string): string[] {
    const rows = this.db
      .prepare<[string], { scope: string }>(
        "SELECT scope FROM credentials WHERE scope LIKE ? || '%'"
      )
      .all(scopePrefix);
    return rows.map((r) => r.scope);
  }

  /** Check if a credential exists. */
  has(scope: string): boolean {
    const row = this.db
      .prepare<[string], { scope: string }>(
        'SELECT scope FROM credentials WHERE scope = ?'
      )
      .get(scope);
    return row !== undefined;
  }

  close(): void {
    this.db.close();
  }

  // ── Salt management + legacy migration ──────────────────────────────────────

  /**
   * Get or create the per-install salt.
   * If the vault has existing credentials but no salt row, migrates them
   * from the legacy hardcoded salt to a new random salt.
   */
  private resolveOrMigrateSalt(masterSecret: string): Buffer {
    const existing = this.db
      .prepare<[], { value: Buffer }>(
        "SELECT value FROM vault_meta WHERE key = 'salt'"
      )
      .get();

    if (existing) return existing.value;

    const newSalt = randomBytes(SALT_LEN);

    const credCount =
      this.db
        .prepare<[], { cnt: number }>('SELECT COUNT(*) as cnt FROM credentials')
        .get()?.cnt ?? 0;

    if (credCount > 0) {
      this.migrateLegacySalt(masterSecret, newSalt);
    }

    this.db
      .prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('salt', ?)")
      .run(newSalt);

    return newSalt;
  }

  /**
   * Decrypt all rows under the legacy hardcoded salt, re-encrypt under the
   * new random salt, and write everything in a single transaction.
   */
  private migrateLegacySalt(masterSecret: string, newSalt: Buffer): void {
    const legacyKey = scryptSync(masterSecret, LEGACY_SALT, KEY_LEN);
    const newKey = scryptSync(masterSecret, newSalt, KEY_LEN);

    interface CredRow {
      scope: string;
      ciphertext: Buffer;
      iv: Buffer;
      auth_tag: Buffer;
      created_at: string;
      updated_at: string;
    }

    const allRows = this.db
      .prepare<[], CredRow>('SELECT * FROM credentials')
      .all();

    const migrateAll = this.db.transaction(() => {
      for (const row of allRows) {
        let plaintext: string;
        try {
          const decipher = createDecipheriv(ALGORITHM, legacyKey, row.iv);
          decipher.setAuthTag(row.auth_tag);
          plaintext = Buffer.concat([
            decipher.update(row.ciphertext),
            decipher.final(),
          ]).toString('utf8');
        } catch {
          console.warn(`[Vault] Migration: skipping undecryptable row scope="${row.scope}"`);
          continue;
        }

        const iv = randomBytes(IV_LEN);
        const cipher = createCipheriv(ALGORITHM, newKey, iv);
        const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const authTag = cipher.getAuthTag();

        this.db
          .prepare(
            'UPDATE credentials SET ciphertext = ?, iv = ?, auth_tag = ? WHERE scope = ?'
          )
          .run(encrypted, iv, authTag, row.scope);
      }
    });

    migrateAll();
    console.log(
      `[Vault] Migrated ${allRows.length} credential(s) from legacy salt to per-install salt.`
    );
  }
}
