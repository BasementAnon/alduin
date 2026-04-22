/**
 * Rule: env-overrides — ALDUIN_* env variable overrides parse correctly.
 */

import type { DoctorRule, DoctorCheckResult, DoctorContext } from '../rule.js';
import { applyEnvOverrides } from '../../../config/env-overrides.js';

/** Env vars that are NOT config path overrides (excluded from validation). */
const EXEMPT_VARS = [
  'ALDUIN_VAULT_SECRET',
  'ALDUIN_AUDIT_HMAC_KEY',
  'ALDUIN_WEBHOOK_SECRET',
  'ALDUIN_ALLOW_LOCAL_INGESTION',
];

export const envOverridesRule: DoctorRule = {
  id: 'env-overrides-parse',
  label: 'ALDUIN_* env overrides parse',

  check(ctx: DoctorContext): DoctorCheckResult {
    const alduinVars = Object.entries(ctx.env).filter(
      ([k]) => k.startsWith('ALDUIN_') && !EXEMPT_VARS.includes(k)
    );
    try {
      applyEnvOverrides({}, ctx.env);
      return {
        id: this.id, label: this.label, status: 'pass',
        detail: alduinVars.length > 0
          ? `${alduinVars.length} override${alduinVars.length === 1 ? '' : 's'} active`
          : '',
        fixable: false,
      };
    } catch (e) {
      return {
        id: this.id, label: this.label, status: 'fail',
        detail: e instanceof Error ? e.message : String(e),
        fixable: false,
      };
    }
  },
};
