import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialVault } from './vault.js'; // now lives in src/secrets/
import Database from 'better-sqlite3';

describe('CredentialVault', () => {
  let vault: CredentialVault;

  beforeEach(() => {
    vault = new CredentialVault(':memory:', 'test-master-secret');
  });

  afterEach(() => {
    vault?.close();
  });

  it('stores and retrieves a credential (encrypted round-trip)', () => {
    vault.set('tenants/acme/users/alice/connectors/gcal/access_token', 'secret-token-123');
    const value = vault.get('tenants/acme/users/alice/connectors/gcal/access_token');
    expect(value).toBe('secret-token-123');
  });

  it('returns null for a missing credential', () => {
    expect(vault.get('nonexistent/scope')).toBeNull();
  });

  it('overwrites an existing credential', () => {
    vault.set('scope/key', 'value-1');
    vault.set('scope/key', 'value-2');
    expect(vault.get('scope/key')).toBe('value-2');
  });

  it('deletes a credential', () => {
    vault.set('scope/to-delete', 'val');
    vault.delete('scope/to-delete');
    expect(vault.get('scope/to-delete')).toBeNull();
  });

  it('lists scopes matching a prefix', () => {
    vault.set('tenants/acme/users/alice/a', '1');
    vault.set('tenants/acme/users/alice/b', '2');
    vault.set('tenants/acme/users/bob/a', '3');

    const aliceScopes = vault.list('tenants/acme/users/alice/');
    expect(aliceScopes).toHaveLength(2);
    expect(aliceScopes).toContain('tenants/acme/users/alice/a');
    expect(aliceScopes).toContain('tenants/acme/users/alice/b');
  });

  it('has() returns true/false correctly', () => {
    vault.set('exists', 'yes');
    expect(vault.has('exists')).toBe(true);
    expect(vault.has('nope')).toBe(false);
  });

  it('handles unicode values correctly', () => {
    vault.set('unicode-test', '日本語テスト 🎉');
    expect(vault.get('unicode-test')).toBe('日本語テスト 🎉');
  });

  it('different master secrets produce different ciphertexts (not decryptable cross-key)', () => {
    vault.set('cross-key', 'original');

    const vault2 = new CredentialVault(':memory:', 'different-secret');
    vault2.set('cross-key', 'original');

    expect(vault.get('cross-key')).toBe('original');
    expect(vault2.get('cross-key')).toBe('original');
    vault2.close();
  });
});

describe('CredentialVault — per-install salt', () => {
  it('generates and persists a random salt on first open', () => {
    const db = new Database(':memory:');
    // Construct the vault — this should create the salt
    const vault = new CredentialVault(':memory:', 'test-secret');
    vault.set('key', 'value');
    expect(vault.get('key')).toBe('value');
    vault.close();
    db.close();
  });

  it('two vaults on separate DBs get different salts, both still work', () => {
    const vault1 = new CredentialVault(':memory:', 'same-secret');
    const vault2 = new CredentialVault(':memory:', 'same-secret');

    vault1.set('x', 'hello');
    vault2.set('x', 'world');

    expect(vault1.get('x')).toBe('hello');
    expect(vault2.get('x')).toBe('world');

    vault1.close();
    vault2.close();
  });

  it('salt is stored in vault_meta table and reused on reopen', () => {
    // Use a file-backed DB to test reopen
    const { mkdtempSync, rmSync } = require('node:fs');
    const { join } = require('node:path');
    const { tmpdir } = require('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'alduin-vault-salt-'));
    const dbPath = join(dir, 'vault.db');

    try {
      // First open: write credentials
      const v1 = new CredentialVault(dbPath, 'persistent-secret');
      v1.set('persist/test', 'my-value');
      v1.close();

      // Second open: should reuse the same salt and decrypt successfully
      const v2 = new CredentialVault(dbPath, 'persistent-secret');
      expect(v2.get('persist/test')).toBe('my-value');
      v2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates legacy credentials when opening a vault without a salt row', () => {
    // Simulate a legacy vault by creating one, inserting credentials with
    // the legacy salt, and removing the vault_meta row before reopening.
    const { mkdtempSync, rmSync } = require('node:fs');
    const { join } = require('node:path');
    const { tmpdir } = require('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'alduin-vault-migrate-'));
    const dbPath = join(dir, 'vault.db');
    const secret = 'migration-test-secret';

    try {
      // Step 1: Create a vault (this generates a new random salt)
      const v1 = new CredentialVault(dbPath, secret);
      v1.set('legacy/cred1', 'value-alpha');
      v1.set('legacy/cred2', 'value-beta');
      v1.close();

      // Step 2: Delete the salt row to simulate a legacy vault
      // and re-encrypt everything with the legacy hardcoded salt
      const { scryptSync, createCipheriv, randomBytes: rb } = require('node:crypto');
      const db = new Database(dbPath);
      db.exec("DELETE FROM vault_meta WHERE key = 'salt'");

      // Read the current (correctly encrypted) rows and re-encrypt with legacy salt
      const legacyKey = scryptSync(secret, 'alduin-vault-salt', 32);
      const rows = db.prepare('SELECT scope FROM credentials').all() as Array<{ scope: string }>;

      for (const row of rows) {
        // We know the values; write them directly with legacy encryption
        const plaintext = row.scope === 'legacy/cred1' ? 'value-alpha' : 'value-beta';
        const iv = rb(12);
        const cipher = createCipheriv('aes-256-gcm', legacyKey, iv);
        const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const authTag = cipher.getAuthTag();
        db.prepare('UPDATE credentials SET ciphertext = ?, iv = ?, auth_tag = ? WHERE scope = ?')
          .run(encrypted, iv, authTag, row.scope);
      }
      db.close();

      // Step 3: Reopen — migration should happen automatically
      const v2 = new CredentialVault(dbPath, secret);
      expect(v2.get('legacy/cred1')).toBe('value-alpha');
      expect(v2.get('legacy/cred2')).toBe('value-beta');

      // And a new salt should now be persisted
      const checkDb = new Database(dbPath);
      const saltRow = checkDb.prepare("SELECT value FROM vault_meta WHERE key = 'salt'").get() as { value: Buffer } | undefined;
      expect(saltRow).toBeDefined();
      expect(saltRow!.value.length).toBe(16);
      checkDb.close();

      v2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── H-1: Transactional rotation ────────────────────────────────────────────

describe('CredentialVault.transaction / rotate / rotateKey (H-1)', () => {
  let vault: CredentialVault;

  beforeEach(() => {
    vault = new CredentialVault(':memory:', 'test-master-secret');
  });

  afterEach(() => {
    vault?.close();
  });

  it('transaction runs all writes atomically on success', () => {
    vault.transaction(() => {
      vault.set('a', '1');
      vault.set('b', '2');
      vault.set('c', '3');
    });
    expect(vault.get('a')).toBe('1');
    expect(vault.get('b')).toBe('2');
    expect(vault.get('c')).toBe('3');
  });

  it('transaction rolls back all writes if the callback throws', () => {
    vault.set('pre-existing', 'keep-me');
    expect(() => {
      vault.transaction(() => {
        vault.set('x', 'would-write');
        vault.set('y', 'would-also-write');
        throw new Error('boom');
      });
    }).toThrow('boom');
    // Neither x nor y should have been persisted.
    expect(vault.get('x')).toBeNull();
    expect(vault.get('y')).toBeNull();
    // But the pre-existing row must be intact.
    expect(vault.get('pre-existing')).toBe('keep-me');
  });

  it('rotate() deletes-then-writes atomically', () => {
    vault.set('old-key', 'old-val');
    vault.rotate({
      deletes: ['old-key'],
      writes: [{ scope: 'new-key', value: 'new-val' }],
    });
    expect(vault.get('old-key')).toBeNull();
    expect(vault.get('new-key')).toBe('new-val');
  });

  it('rotate() leaves old entries intact if a write fails mid-transaction', () => {
    vault.set('keep-1', 'v1');
    vault.set('keep-2', 'v2');
    // Pass an invalid value type (number) — the setter throws, which
    // should cancel the whole transaction.
    expect(() => {
      vault.rotate({
        deletes: ['keep-1'],
        writes: [
          { scope: 'new', value: 'ok' },
          { scope: 'bad', value: 123 as unknown as string },
        ],
      });
    }).toThrow();
    // keep-1 MUST still exist — the delete got rolled back.
    expect(vault.get('keep-1')).toBe('v1');
    expect(vault.get('keep-2')).toBe('v2');
    expect(vault.get('new')).toBeNull();
  });

  it('rotateKey() renames a single scope atomically', () => {
    vault.set('profiles/old', 'payload');
    vault.rotateKey('profiles/old', 'profiles/new', 'payload');
    expect(vault.get('profiles/old')).toBeNull();
    expect(vault.get('profiles/new')).toBe('payload');
  });

  it('rotateKey() does not delete when old and new scopes match (update-in-place)', () => {
    vault.set('profiles/same', 'v1');
    vault.rotateKey('profiles/same', 'profiles/same', 'v2');
    expect(vault.get('profiles/same')).toBe('v2');
  });
});
