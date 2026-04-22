// ─────────────────────────────────────────────────────────────
// Adapted from OpenClaw (MIT, (c) Peter Steinberger)
//   Origin: src/agents/auth-profiles/index.ts
//   Origin SHA: 778ac4330aa32b9ce4482f0d1a3d4f744ff7f17f
//   Ported: 2026-04-18
// ─────────────────────────────────────────────────────────────

/**
 * Auth profile manager -- bridges the rotation engine with
 * CredentialVault and provider config.
 *
 * Builds profiles from the vault's credential scopes and feeds
 * them into per-provider ProfileRotator instances.
 */

import type { CredentialVault } from '../../secrets/vault.js';
import type { AuthProfile, RotationConfig } from './types.js';
import { ProfileRotator } from './rotation.js';

export { ProfileRotator } from './rotation.js';
export type {
  AuthProfile,
  ProfileHealth,
  ProfileOutcome,
  RotationConfig,
} from './types.js';
export { DEFAULT_ROTATION_CONFIG } from './types.js';

/**
 * Build ProfileRotator instances for each provider that has
 * multiple credentials in the vault.
 *
 * Vault scope convention: `providers/{providerId}/keys/{keyIndex}`
 * Example: `providers/anthropic/keys/0`, `providers/anthropic/keys/1`
 *
 * Providers with only one key (the common case) get a single-profile
 * rotator -- rotation is a no-op but the health tracking still applies.
 *
 * @param vault       The credential vault to scan.
 * @param providerIds List of provider IDs to build rotators for.
 * @param config      Optional rotation config overrides.
 * @returns Map of provider ID -> ProfileRotator.
 */
export function buildRotators(
  vault: CredentialVault,
  providerIds: string[],
  config?: Partial<RotationConfig>,
): Map<string, ProfileRotator> {
  const rotators = new Map<string, ProfileRotator>();

  for (const providerId of providerIds) {
    const rotator = new ProfileRotator(config);

    // Scan vault for all keys under this provider's scope
    const scopePrefix = `providers/${providerId}/keys/`;
    const scopes = vault.list(scopePrefix);

    if (scopes.length === 0) {
      // No vault-managed keys -- create a profile from the legacy
      // env-var path (single key). The actual credential is retrieved
      // at call time, not stored in the profile.
      const profile: AuthProfile = {
        id: `${providerId}-env`,
        provider: providerId,
        vaultScope: `providers/${providerId}/env`,
        priority: 0,
        health: 'healthy',
        lastSuccessAt: null,
        lastFailureAt: null,
        consecutiveFailures: 0,
        retryAfter: null,
      };
      rotator.addProfile(profile);
    } else {
      // Multiple vault-managed keys -- create one profile per key
      for (let i = 0; i < scopes.length; i++) {
        const profile: AuthProfile = {
          id: `${providerId}-key-${i}`,
          provider: providerId,
          vaultScope: scopes[i],
          priority: i,
          health: 'healthy',
          lastSuccessAt: null,
          lastFailureAt: null,
          consecutiveFailures: 0,
          retryAfter: null,
        };
        rotator.addProfile(profile);
      }
    }

    rotators.set(providerId, rotator);
  }

  return rotators;
}
