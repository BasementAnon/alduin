import { describe, it, expect, afterEach } from 'vitest';
import { OSKeychain, InMemoryKeychain } from './keychain.js';

describe('OSKeychain — audit HMAC key', () => {
  afterEach(() => {
    delete process.env['ALDUIN_AUDIT_HMAC_KEY'];
  });

  it('getAuditHmacKey returns env var when set', async () => {
    process.env['ALDUIN_AUDIT_HMAC_KEY'] = 'env-audit-key-abc123';
    const kc = new OSKeychain();
    const key = await kc.getAuditHmacKey();
    expect(key).toBe('env-audit-key-abc123');
  });

  it('getAuditHmacKey throws when neither keytar nor env var is available', async () => {
    delete process.env['ALDUIN_AUDIT_HMAC_KEY'];
    const kc = new OSKeychain();

    await expect(kc.getAuditHmacKey()).rejects.toThrow(
      'Cannot obtain audit HMAC key'
    );
  });

  it('getMasterSecret throws when neither keytar nor env var is available', async () => {
    delete process.env['ALDUIN_VAULT_SECRET'];
    const kc = new OSKeychain();

    await expect(kc.getMasterSecret()).rejects.toThrow(
      'Cannot obtain vault master secret'
    );
  });
});

describe('InMemoryKeychain — audit HMAC key', () => {
  it('round-trips audit key via get/set', async () => {
    const kc = new InMemoryKeychain('vault-secret', 'initial-audit-key');
    expect(await kc.getAuditHmacKey()).toBe('initial-audit-key');

    await kc.setAuditHmacKey('new-audit-key');
    expect(await kc.getAuditHmacKey()).toBe('new-audit-key');
  });

  it('defaults audit key to a test value', async () => {
    const kc = new InMemoryKeychain();
    const key = await kc.getAuditHmacKey();
    expect(key).toBeTruthy();
    expect(key.length).toBeGreaterThan(0);
  });
});
