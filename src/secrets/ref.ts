// ─────────────────────────────────────────────────────────────
// Adapted from OpenClaw (MIT, © Peter Steinberger)
//   Origin: src/config/types.secrets.ts
//   Origin SHA: 778ac4330aa32b9ce4482f0d1a3d4f744ff7f17f
//   Ported: 2026-04-15
// ─────────────────────────────────────────────────────────────

import type { CredentialVault } from './vault.js';

/**
 * A reference to a secret stored in the Alduin credential vault.
 * `secret` is the vault scope key (e.g. "providers/anthropic/api_key").
 */
export interface SecretRef {
  secret: string;
}

/**
 * A config value that may be provided inline (plain string) or as a vault
 * reference. SecretRef values are resolved before Zod validation runs so the
 * rest of the config sees plain strings.
 */
export type SecretInput = string | SecretRef;

/** Type guard — returns true for `{ secret: string }` shaped values. */
export function isSecretRef(value: unknown): value is SecretRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'secret' in value &&
    typeof (value as Record<string, unknown>)['secret'] === 'string' &&
    (value as SecretRef).secret.length > 0
  );
}

/**
 * Resolve a SecretInput to a plain string.
 *
 * - If `input` is already a string it is returned as-is.
 * - If `input` is a SecretRef, the vault is queried for `input.secret`.
 *   Returns null when the scope is not found in the vault.
 *
 * @param input  The value from config (string or SecretRef).
 * @param vault  The CredentialVault to query.  Pass null to skip vault
 *               resolution — SecretRef inputs will return null.
 */
export function resolveSecret(
  input: SecretInput,
  vault: CredentialVault | null
): string | null {
  if (typeof input === 'string') return input;
  if (vault === null) return null;
  return vault.get(input.secret);
}

/** Maximum nesting depth walked by {@link resolveSecrets}. */
export const MAX_RESOLVE_DEPTH = 10;

/**
 * Walk a raw (pre-Zod) config object and replace every `{ secret: "..." }`
 * value with the plaintext fetched from the vault.
 *
 * Mutates `obj` in place and returns it for chaining.
 * Unknown SecretRefs (scope not in vault) are left in place so that Zod
 * validation can emit a clear error.
 *
 * A `depth` parameter caps recursion at {@link MAX_RESOLVE_DEPTH} nested
 * levels (default 10). YAML parsers like `yaml` can return object graphs
 * with reference cycles (`&anchor` / `*alias`) — without a cap the walk
 * would recurse until the stack overflows. On overflow we throw a clear
 * error rather than silently truncating, so the offending config is
 * obvious to the operator.
 */
export function resolveSecrets(
  obj: Record<string, unknown>,
  vault: CredentialVault | null,
  depth = 0
): Record<string, unknown> {
  if (depth > MAX_RESOLVE_DEPTH) {
    throw new Error(
      `Secret resolution depth exceeded (possible cyclic reference): nesting exceeded ${MAX_RESOLVE_DEPTH} levels`
    );
  }

  for (const [key, value] of Object.entries(obj)) {
    if (isSecretRef(value)) {
      const resolved = resolveSecret(value, vault);
      if (resolved !== null) {
        obj[key] = resolved;
      }
      // If null: leave the SecretRef shape — Zod will reject the non-string value.
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      resolveSecrets(value as Record<string, unknown>, vault, depth + 1);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          resolveSecrets(item as Record<string, unknown>, vault, depth + 1);
        }
      }
    }
  }
  return obj;
}
