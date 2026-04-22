/**
 * Rule: config-valid — YAML schema validation via Zod.
 */

import type { DoctorRule, DoctorCheckResult, DoctorContext } from '../rule.js';
import { loadConfig } from '../../../config/loader.js';

export const configValidRule: DoctorRule = {
  id: 'config-valid',
  label: 'Schema validation',

  check(ctx: DoctorContext): DoctorCheckResult {
    const result = loadConfig(ctx.configPath, null, ctx.env);
    if (result.ok) {
      return { id: this.id, label: this.label, status: 'pass', detail: '', fixable: false };
    }
    return {
      id: this.id,
      label: this.label,
      status: 'fail',
      detail: result.error.message,
      fixable: false,
    };
  },
};
