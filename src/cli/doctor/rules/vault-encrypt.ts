/**
 * Rule: vault-encrypt — vault AES-256-GCM round-trip test.
 */

import { existsSync } from 'node:fs';
import type { DoctorRule, DoctorCheckResult, DoctorContext } from '../rule.js';
import { CredentialVault } from '../../../secrets/vault.js';
import { OSKeychain } from '../../../connectors/keychain.js';

export const vaultEncryptRule: DoctorRule = {
  id: 'vault-encrypt',
  label: 'Vault encrypt/decrypt round-trip',

  async check(ctx: DoctorContext): Promise<DoctorCheckResult> {
    if (ctx.skipVault || !existsSync(ctx.vaultPath)) {
      return {
        id: this.id, label: this.label, status: 'skip',
        detail: ctx.skipVault ? 'Vault check skipped' : `No vault at ${ctx.vaultPath}`,
        fixable: false,
      };
    }

    try {
      const keychain = new OSKeychain();
      const masterSecret = await keychain.getMasterSecret().catch(() => null);
      if (!masterSecret) {
        return {
          id: this.id, label: this.label, status: 'skip',
          detail: 'No master secret (keytar not installed and ALDUIN_VAULT_SECRET not set)',
          fixable: false,
        };
      }
      const vault = new CredentialVault(ctx.vaultPath, masterSecret);
      const TEST_SCOPE = '__alduin_doctor_test__';
      const TEST_VALUE = `probe-${Date.now()}`;
      vault.set(TEST_SCOPE, TEST_VALUE);
      const retrieved = vault.get(TEST_SCOPE);
      vault.delete(TEST_SCOPE);
      vault.close();
      if (retrieved === TEST_VALUE) {
        return { id: this.id, label: this.label, status: 'pass', detail: '', fixable: false };
      }
      return { id: this.id, label: this.label, status: 'fail', detail: 'Round-trip mismatch', fixable: false };
    } catch (e) {
      return {
        id: this.id, label: this.label, status: 'fail',
        detail: e instanceof Error ? e.message : String(e),
        fixable: false,
      };
    }
  },
};
