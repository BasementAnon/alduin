import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapOwner } from './bootstrap.js';
import { RoleResolver } from './roles.js';

describe('bootstrapOwner (H-10 guard)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('seeds the first owner when none exists', () => {
    const result = bootstrapOwner(db, { tenantId: 'acme', userId: '42' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ tenantId: 'acme', userId: '42' });

    const resolver = RoleResolver.create(db);
    expect(resolver.resolve('acme', '42', false)).toBe('owner');
  });

  it('refuses to overwrite an existing owner for the same tenant', () => {
    const resolver = RoleResolver.create(db);
    resolver.setRole('acme', '42', 'owner');

    const result = bootstrapOwner(db, { tenantId: 'acme', userId: '99' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('owner_exists');
    if (result.error.kind !== 'owner_exists') return;
    expect(result.error.existingUserId).toBe('42');

    // The original owner must NOT have been overwritten.
    expect(resolver.resolve('acme', '42', false)).toBe('owner');
    // And the attempted new user must NOT have been promoted.
    expect(resolver.resolve('acme', '99', false)).toBe('guest');
  });

  it('allows a separate tenant to bootstrap its own owner independently', () => {
    const first = bootstrapOwner(db, { tenantId: 'acme', userId: '42' });
    expect(first.ok).toBe(true);

    const second = bootstrapOwner(db, { tenantId: 'globex', userId: '77' });
    expect(second.ok).toBe(true);

    const resolver = RoleResolver.create(db);
    expect(resolver.resolve('acme', '42', false)).toBe('owner');
    expect(resolver.resolve('globex', '77', false)).toBe('owner');
  });

  it('rejects empty tenantId or userId as invalid input', () => {
    const emptyTenant = bootstrapOwner(db, { tenantId: '  ', userId: '42' });
    expect(emptyTenant.ok).toBe(false);
    if (emptyTenant.ok) return;
    expect(emptyTenant.error.kind).toBe('invalid_input');

    const emptyUser = bootstrapOwner(db, { tenantId: 'acme', userId: '' });
    expect(emptyUser.ok).toBe(false);
    if (emptyUser.ok) return;
    expect(emptyUser.error.kind).toBe('invalid_input');
  });

  it('treats a prior admin (non-owner) as not blocking the bootstrap', () => {
    const resolver = RoleResolver.create(db);
    // Pre-existing admin must not block owner seeding — only an owner does.
    resolver.setRole('acme', '1', 'admin');

    const result = bootstrapOwner(db, { tenantId: 'acme', userId: '42' });
    expect(result.ok).toBe(true);
    expect(resolver.resolve('acme', '42', false)).toBe('owner');
    expect(resolver.resolve('acme', '1', false)).toBe('admin');
  });
});
