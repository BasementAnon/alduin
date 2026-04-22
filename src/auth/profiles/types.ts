// ─────────────────────────────────────────────────────────────
// Adapted from OpenClaw (MIT, (c) Peter Steinberger)
//   Origin: src/agents/auth-profiles/index.ts (profile types)
//   Origin SHA: 778ac4330aa32b9ce4482f0d1a3d4f744ff7f17f
//   Ported: 2026-04-18
// ─────────────────────────────────────────────────────────────

/**
 * Types for the auth-profile rotation system.
 *
 * An "auth profile" is a single credential (API key) for a specific provider.
 * Multiple profiles can exist per provider, enabling key rotation on
 * rate-limit (429) or server errors (5xx).
 */

/** Health state of a single auth profile. */
export type ProfileHealth = 'healthy' | 'degraded' | 'dead';

/** A single credential profile for a provider. */
export interface AuthProfile {
  /** Unique identifier for this profile (e.g. "anthropic-key-1"). */
  id: string;
  /** Provider this profile authenticates with. */
  provider: string;
  /** Vault scope key where the credential is stored. */
  vaultScope: string;
  /** Priority (lower = preferred). Profiles are tried in priority order. */
  priority: number;
  /** Current health state. */
  health: ProfileHealth;
  /** Timestamp of the last successful request. */
  lastSuccessAt: number | null;
  /** Timestamp of the last failure. */
  lastFailureAt: number | null;
  /** Number of consecutive failures. */
  consecutiveFailures: number;
  /** If rate-limited, the earliest time to retry (epoch ms). */
  retryAfter: number | null;
}

/** Outcome of attempting to use a profile. */
export interface ProfileOutcome {
  /** Whether the request succeeded. */
  success: boolean;
  /** HTTP status code, if applicable. */
  statusCode?: number;
  /** If rate-limited, how long to wait before retrying (ms). */
  retryAfterMs?: number;
}

/** Configuration for the rotation strategy. */
export interface RotationConfig {
  /** Number of consecutive failures before marking a profile as dead. */
  maxConsecutiveFailures: number;
  /** How long a dead profile stays dead before being retried (ms). */
  deadCooldownMs: number;
  /** How long a degraded profile stays degraded before being retried (ms). */
  degradedCooldownMs: number;
}

export const DEFAULT_ROTATION_CONFIG: RotationConfig = {
  maxConsecutiveFailures: 5,
  deadCooldownMs: 5 * 60 * 1000,   // 5 minutes
  degradedCooldownMs: 30 * 1000,    // 30 seconds
};
