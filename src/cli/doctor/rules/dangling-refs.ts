/**
 * Rule: dangling-refs — no unresolved SecretRef scopes in config.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { DoctorRule, DoctorCheckResult, DoctorContext } from '../rule.js';
import { isSecretRef } from '../../../secrets/ref.js';
import { CredentialVault } from '../../../secrets/vault.js';
import { OSKeychain } from '../../../connectors/keychain.js';

function collectDangling(
  node: unknown,
  path: string,
  vault: CredentialVault,
  out: string[],
): void {
  if (isSecretRef(node)) {
    if (!vault.has(node.secret)) out.push(`${path}→${node.secret}`);
    return;
  }
  if (typeof node === 'object' && node !== null && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      collectDangling(v, path ? `${path}.${k}` : k, vault, out);
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectDangling(item, `${path}[${i}]`, vault, out));
  }
}

export const danglingRefsRule: DoctorRule = {
  id: 'no-dangling-refs',
  label: 'No unresolved SecretRefs',

  async check(ctx: DoctorContext): Promise<DoctorCheckResult> {
    if (ctx.skipVault || !existsSync(ctx.vaultPath)) {
      return {
        id: this.id, label: this.label, status: 'skip',
        detail: ctx.skipVault ? 'Vault check skipped' : 'Vault not available',
        fixable: false,
      };
    }
    if (!existsSync(ctx.configPath)) {
      return { id: this.id, label: this.label, status: 'skip', detail: 'Config not found', fixable: false };
    }

    let vault: CredentialVault | null = null;
    try {
      const keychain = new OSKeychain();
      const masterSecret = await keychain.getMasterSecret().catch(() => null);
      if (!masterSecret) {
        return {
          id: this.id, label: this.label, status: 'skip',
          detail: 'No master secret — cannot open vault',
          fixable: false,
        };
      }
      vault = new CredentialVault(ctx.vaultPath, masterSecret);
      const raw = parseYaml(readFileSync(ctx.configPath, 'utf-8')) as unknown;
      const dangling: string[] = [];
      collectDangling(raw, '', vault, dangling);
      vault.close();
      vault = null;

      if (dangling.length > 0) {
        return {
          id: this.id, label: this.label, status: 'fail',
          detail: `Unresolved: ${dangling.join(', ')}`,
          fixable: false,
        };
      }
      return { id: this.id, label: this.label, status: 'pass', detail: '', fixable: false };
    } catch (e) {
      vault?.close();
      return {
        id: this.id, label: this.label, status: 'fail',
        detail: e instanceof Error ? e.message : String(e),
        fixable: false,
      };
    }
  },
};
