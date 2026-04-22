/**
 * Owner bootstrap helper.
 *
 * Seeds the first `owner` role for a tenant. Guarded so it can be called at
 * most once per tenant — once an owner exists, subsequent calls return an
 * `owner_exists` error instead of overwriting the existing owner. This is the
 * fix for H-10 (Alduin security audit): without the guard, a second invocation
 * could silently replace the intended owner, allowing privilege takeover.
 *
 * Used by:
 *   - `alduin admin bootstrap --tenant <t> --user-id <u>` (src/cli.ts)
 *   - the init wizard's owner step (src/cli/wizard/steps/owner.ts)
 */

import type Database from 'better-sqlite3';
import { RoleResolver } from './roles.js';
import type { Result } from '../types/result.js';
import { err, ok } from '../types/result.js';

export type OwnerBootstrapError =
  | { kind: 'owner_exists'; tenantId: string; existingUserId: string }
  | { kind: 'invalid_input'; reason: string };

export interface BootstrapOwnerInput {
  tenantId: string;
  userId: string;
}

/**
 * Create the first `owner` role for a tenant if none exists.
 *
 * Returns `{ ok: true, value: { tenantId, userId } }` on success; returns
 * `{ ok: false, error: { kind: 'owner_exists', ... } }` if the tenant already
 * has an owner (cannot be called twice — use role management commands to
 * transfer ownership explicitly).
 */
export function bootstrapOwner(
  db: Database.Database,
  input: BootstrapOwnerInput
): Result<{ tenantId: string; userId: string }, OwnerBootstrapError> {
  const tenantId = input.tenantId.trim();
  const userId = input.userId.trim();

  if (!tenantId) {
    return err({ kind: 'invalid_input', reason: 'tenantId is required' });
  }
  if (!userId) {
    return err({ kind: 'invalid_input', reason: 'userId is required' });
  }

  const resolver = RoleResolver.create(db);

  // Guard: refuse to bootstrap if an owner already exists for this tenant.
  const existing = resolver
    .listRoles(tenantId)
    .find((r) => r.role === 'owner');
  if (existing) {
    return err({
      kind: 'owner_exists',
      tenantId,
      existingUserId: existing.user_id,
    });
  }

  resolver.setRole(tenantId, userId, 'owner');
  return ok({ tenantId, userId });
}

/** Format a bootstrap error as a human-readable CLI message. */
export function formatBootstrapError(e: OwnerBootstrapError): string {
  switch (e.kind) {
    case 'owner_exists':
      return (
        `Tenant "${e.tenantId}" already has an owner (user_id="${e.existingUserId}"). ` +
        'Refusing to overwrite. Use the admin role commands to transfer ownership.'
      );
    case 'invalid_input':
      return `Invalid input: ${e.reason}`;
  }
}
