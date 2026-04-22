// ─────────────────────────────────────────────────────────────
// Adapted from OpenClaw (MIT, (c) Peter Steinberger)
//   Origin: src/agents/auth-profiles/rotation.ts
//   Origin SHA: 778ac4330aa32b9ce4482f0d1a3d4f744ff7f17f
//   Ported: 2026-04-18
// ─────────────────────────────────────────────────────────────

/**
 * Auth-profile rotation engine.
 *
 * Given multiple API keys for the same provider, rotates through them
 * based on health, priority, and rate-limit state. Integrated with
 * CredentialVault for secure key retrieval.
 *
 * Design decisions (diverged from OpenClaw):
 *   - Dropped OAuth flows specific to OpenClaw's bundled channels.
 *   - Simplified to priority + health + retry_after rotation only.
 *   - CredentialVault integration (OpenClaw used plaintext JSON).
 */

import type {
  AuthProfile,
  ProfileOutcome,
  ProfileHealth,
  RotationConfig,
} from './types.js';
import { DEFAULT_ROTATION_CONFIG } from './types.js';

/**
 * Manages a set of auth profiles for a single provider and selects
 * the best one for each request.
 *
 * Thread-safety: this class is NOT thread-safe. In Alduin's single-
 * threaded event loop, this is fine. If multi-threaded access is ever
 * needed, wrap select() and report() in a mutex.
 */
export class ProfileRotator {
  private profiles: Map<string, AuthProfile> = new Map();
  private config: RotationConfig;

  constructor(config: Partial<RotationConfig> = {}) {
    this.config = { ...DEFAULT_ROTATION_CONFIG, ...config };
  }

  /**
   * Add a profile to the rotation pool.
   * Lower priority values are preferred.
   */
  addProfile(profile: AuthProfile): void {
    this.profiles.set(profile.id, profile);
  }

  /** Remove a profile from the rotation pool. */
  removeProfile(id: string): void {
    this.profiles.delete(id);
  }

  /**
   * Atomically replace the profile at `oldProfileId` with `newProfile`.
   *
   * The in-memory rotation pool is a plain Map, so this is trivially
   * atomic at the engine level. When callers rotate the *underlying*
   * credential in the vault (the typical flow: delete the old API key
   * row, write a new API key row, then swap the in-memory profile), the
   * vault side must be made crash-safe too — see
   * `CredentialVault.rotateKey` / `CredentialVault.rotate`, which wrap
   * the delete + write pair in a single SQLite transaction. H-1.
   */
  rotateProfile(oldProfileId: string, newProfile: AuthProfile): void {
    this.profiles.delete(oldProfileId);
    this.profiles.set(newProfile.id, newProfile);
  }

  /** Get all profiles, sorted by priority (ascending). */
  getProfiles(): AuthProfile[] {
    return Array.from(this.profiles.values()).sort((a, b) => a.priority - b.priority);
  }

  /** Number of profiles in the pool. */
  get size(): number {
    return this.profiles.size;
  }

  /**
   * Select the best profile for the next request.
   *
   * Selection logic (in order):
   *   1. Skip profiles that are rate-limited (retryAfter > now).
   *   2. Skip dead profiles unless their cooldown has elapsed.
   *   3. Among remaining, prefer healthy > degraded.
   *   4. Within the same health tier, prefer lower priority number.
   *
   * Returns null if no profile is available (all rate-limited or dead).
   */
  select(): AuthProfile | null {
    const now = Date.now();
    const candidates: AuthProfile[] = [];

    for (const profile of this.profiles.values()) {
      // Skip rate-limited profiles
      if (profile.retryAfter !== null && profile.retryAfter > now) {
        continue;
      }

      // Skip dead profiles unless cooldown has elapsed
      if (profile.health === 'dead') {
        const elapsed = profile.lastFailureAt !== null
          ? now - profile.lastFailureAt
          : Infinity;
        if (elapsed < this.config.deadCooldownMs) {
          continue;
        }
        // Cooldown elapsed -- give it another chance as degraded
      }

      // Skip degraded profiles if their cooldown hasn't elapsed
      if (profile.health === 'degraded') {
        const elapsed = profile.lastFailureAt !== null
          ? now - profile.lastFailureAt
          : Infinity;
        if (elapsed < this.config.degradedCooldownMs) {
          continue;
        }
      }

      candidates.push(profile);
    }

    if (candidates.length === 0) return null;

    // Sort: healthy first, then by priority
    candidates.sort((a, b) => {
      const healthOrder = healthRank(a.health) - healthRank(b.health);
      if (healthOrder !== 0) return healthOrder;
      return a.priority - b.priority;
    });

    return candidates[0];
  }

  /**
   * Report the outcome of using a profile.
   * Updates health, failure counters, and retry-after state.
   */
  report(profileId: string, outcome: ProfileOutcome): void {
    const profile = this.profiles.get(profileId);
    if (!profile) return;

    const now = Date.now();

    if (outcome.success) {
      profile.health = 'healthy';
      profile.consecutiveFailures = 0;
      profile.lastSuccessAt = now;
      profile.retryAfter = null;
    } else {
      profile.consecutiveFailures += 1;
      profile.lastFailureAt = now;

      // Rate-limited (429)
      if (outcome.statusCode === 429) {
        profile.health = 'degraded';
        profile.retryAfter = outcome.retryAfterMs
          ? now + outcome.retryAfterMs
          : now + this.config.degradedCooldownMs;
      }
      // Server errors (5xx)
      else if (outcome.statusCode !== undefined && outcome.statusCode >= 500) {
        profile.health = 'degraded';
      }

      // Too many consecutive failures -- mark dead
      if (profile.consecutiveFailures >= this.config.maxConsecutiveFailures) {
        profile.health = 'dead';
      }
    }
  }

  /**
   * Reset a profile's health to healthy.
   * Useful when an admin manually re-enables a dead profile.
   */
  resetHealth(profileId: string): void {
    const profile = this.profiles.get(profileId);
    if (!profile) return;
    profile.health = 'healthy';
    profile.consecutiveFailures = 0;
    profile.retryAfter = null;
  }

  /** Get a snapshot of all profile health states. */
  healthSnapshot(): Array<{ id: string; provider: string; health: ProfileHealth; priority: number }> {
    return this.getProfiles().map((p) => ({
      id: p.id,
      provider: p.provider,
      health: p.health,
      priority: p.priority,
    }));
  }
}

/** Numeric rank for health sorting (lower = better). */
function healthRank(health: ProfileHealth): number {
  switch (health) {
    case 'healthy': return 0;
    case 'degraded': return 1;
    case 'dead': return 2;
  }
}
