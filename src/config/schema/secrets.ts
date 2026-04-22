import { z } from 'zod';

/**
 * A reference to a secret stored in the Alduin credential vault.
 * The `secret` field is the vault scope key (e.g. "providers/anthropic/api_key").
 *
 * This is intentionally simpler than OpenClaw's multi-source SecretRef;
 * the Alduin vault is the single source of truth for secrets.
 * Full resolution logic lives in src/secrets/ref.ts.
 */
export const secretRefSchema = z.object({
  secret: z.string().min(1, 'SecretRef.secret (vault scope key) must be non-empty'),
});

export type SecretRef = z.output<typeof secretRefSchema>;

/**
 * Any config field that may hold a secret.
 * Either a plain string (inline — acceptable for dev) or a SecretRef
 * that is resolved from the vault before Zod validation runs.
 */
export const secretInputSchema = z.union([z.string(), secretRefSchema]);

export type SecretInput = z.output<typeof secretInputSchema>;
