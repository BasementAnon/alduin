/**
 * Rule: dotenv-secrets — .env file still contains secrets that should
 * be migrated to the vault.
 *
 * Fixable: migrates matching secrets into the vault and rewrites the
 * .env key to an empty value.
 */

import { existsSync } from 'node:fs';
import type { DoctorRule, DoctorCheckResult, DoctorContext } from '../rule.js';
import { migrateFromDotenv } from '../../../secrets/migrate.js';
import { CredentialVault } from '../../../secrets/vault.js';
import { OSKeychain } from '../../../connectors/keychain.js';

/** Env var prefixes / names that are secret material. */
const SECRET_PATTERNS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'ALDUIN_VAULT_SECRET',
  'ALDUIN_AUDIT_HMAC_KEY',
  'ALDUIN_WEBHOOK_SECRET',
];

function detectSecretsInEnv(env: Record<string, string | undefined>): string[] {
  return SECRET_PATTERNS.filter((k) => {
    const v = env[k];
    return typeof v === 'string' && v.length > 0;
  });
}

export const dotenvSecretsRule: DoctorRule = {
  id: 'dotenv-secrets',
  label: '.env secrets migrated to vault',

  check(ctx: DoctorContext): DoctorCheckResult {
    const present = detectSecretsInEnv(ctx.env);

    if (present.length === 0) {
      return { id: this.id, label: this.label, status: 'pass', detail: '', fixable: false };
    }

    return {
      id: this.id, label: this.label, status: 'warn',
      detail: `Secrets in env: ${present.join(', ')} — migrate to vault`,
      fixable: true,
    };
  },

  async fix(ctx: DoctorContext): Promise<string | null> {
    if (ctx.skipVault) return 'dotenv-secrets: vault skipped';
    try {
      const keychain = new OSKeychain();
      const masterSecret = await keychain.getMasterSecret().catch(() => null);
      if (!masterSecret) return 'dotenv-secrets: no vault master secret available';
      const vault = new CredentialVault(ctx.vaultPath, masterSecret);
      const result = migrateFromDotenv(vault);
      vault.close();
      if (result.imported > 0) {
        return `Migrated ${result.imported} secret(s) from .env to vault: ${result.keys.join(', ')}`;
      }
      if (result.skipped.length > 0) {
        return `dotenv-secrets: all secrets already in vault (${result.skipped.length} skipped)`;
      }
      return 'dotenv-secrets: no matching env vars found';
    } catch (e) {
      return `dotenv-secrets migration failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};
