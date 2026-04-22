import { describe, it, expect } from 'vitest';
import { isSecretRef, resolveSecret, resolveSecrets, MAX_RESOLVE_DEPTH } from './ref.js';
import { CredentialVault } from './vault.js';

// ── isSecretRef ──────────────────────────────────────────────────────────────

describe('isSecretRef', () => {
  it('returns true for a valid SecretRef', () => {
    expect(isSecretRef({ secret: 'providers/anthropic/api_key' })).toBe(true);
  });

  it('returns false for a plain string', () => {
    expect(isSecretRef('sk-xxx')).toBe(false);
  });

  it('returns false for an object missing the secret key', () => {
    expect(isSecretRef({ key: 'value' })).toBe(false);
  });

  it('returns false for an object with an empty secret', () => {
    expect(isSecretRef({ secret: '' })).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isSecretRef(null)).toBe(false);
    expect(isSecretRef(undefined)).toBe(false);
  });
});

// ── resolveSecret ─────────────────────────────────────────────────────────────

describe('resolveSecret', () => {
  it('returns the string directly when input is a plain string', () => {
    expect(resolveSecret('plaintext', null)).toBe('plaintext');
  });

  it('resolves a SecretRef from the vault', () => {
    const vault = new CredentialVault(':memory:', 'test-master');
    vault.set('providers/anthropic/api_key', 'sk-secret');

    expect(resolveSecret({ secret: 'providers/anthropic/api_key' }, vault)).toBe('sk-secret');
    vault.close();
  });

  it('returns null for an unknown vault scope', () => {
    const vault = new CredentialVault(':memory:', 'test-master');
    expect(resolveSecret({ secret: 'does/not/exist' }, vault)).toBeNull();
    vault.close();
  });

  it('returns null for a SecretRef when vault is null', () => {
    expect(resolveSecret({ secret: 'some/scope' }, null)).toBeNull();
  });
});

// ── resolveSecrets (deep walk) ────────────────────────────────────────────────

describe('resolveSecrets', () => {
  it('replaces a SecretRef with the vault value at any depth', () => {
    const vault = new CredentialVault(':memory:', 'test-master');
    vault.set('providers/anthropic/api_key', 'sk-resolved');

    const raw: Record<string, unknown> = {
      providers: {
        anthropic: {
          api_key: { secret: 'providers/anthropic/api_key' },
        },
      },
    };

    resolveSecrets(raw, vault);

    expect(
      ((raw.providers as Record<string, unknown>)['anthropic'] as Record<string, unknown>)[
        'api_key'
      ]
    ).toBe('sk-resolved');
    vault.close();
  });

  it('leaves plain string values untouched', () => {
    const vault = new CredentialVault(':memory:', 'test-master');
    const raw: Record<string, unknown> = { foo: 'bar' };
    resolveSecrets(raw, vault);
    expect(raw['foo']).toBe('bar');
    vault.close();
  });

  it('leaves an unresolvable SecretRef in place when scope is missing', () => {
    const vault = new CredentialVault(':memory:', 'test-master');
    const ref = { secret: 'missing/scope' };
    const raw: Record<string, unknown> = { key: ref };
    resolveSecrets(raw, vault);
    // Left as-is — Zod will reject it at validation time
    expect(raw['key']).toEqual(ref);
    vault.close();
  });

  it('handles nested arrays of objects', () => {
    const vault = new CredentialVault(':memory:', 'test-master');
    vault.set('some/token', 'tok-abc');

    const raw: Record<string, unknown> = {
      items: [{ token: { secret: 'some/token' } }, { token: 'static' }],
    };

    resolveSecrets(raw, vault);

    const items = raw['items'] as Array<Record<string, unknown>>;
    expect(items[0]!['token']).toBe('tok-abc');
    expect(items[1]!['token']).toBe('static');
    vault.close();
  });

  it('throws a clear error on a cyclic object (depth cap)', () => {
    // Build an object that references itself — YAML with `&anchor` / `*alias`
    // can produce this. Without the depth cap, the walk stack-overflows.
    const root: Record<string, unknown> = { name: 'root' };
    root['self'] = root;

    expect(() => resolveSecrets(root, null)).toThrow(
      /Secret resolution depth exceeded/
    );
  });

  it('succeeds on deeply but finitely nested objects just under the cap', () => {
    // Build a chain of exactly MAX_RESOLVE_DEPTH levels — should NOT throw.
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let i = 0; i < MAX_RESOLVE_DEPTH; i++) {
      const next: Record<string, unknown> = {};
      cursor['next'] = next;
      cursor = next;
    }
    cursor['leaf'] = 'value';

    expect(() => resolveSecrets(root, null)).not.toThrow();
  });

  it('throws when nesting just exceeds the cap', () => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    // MAX_RESOLVE_DEPTH + 2 levels guarantees overflow even with the
    // "depth starts at 0, allowed up to MAX" accounting.
    for (let i = 0; i < MAX_RESOLVE_DEPTH + 2; i++) {
      const next: Record<string, unknown> = {};
      cursor['next'] = next;
      cursor = next;
    }

    expect(() => resolveSecrets(root, null)).toThrow(
      /Secret resolution depth exceeded/
    );
  });
});
