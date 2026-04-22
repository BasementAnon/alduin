/**
 * Rule: models-exist — all model pins exist in the catalog.
 */

import type { DoctorRule, DoctorCheckResult, DoctorContext } from '../rule.js';

export const modelsExistRule: DoctorRule = {
  id: 'models-exist',
  label: 'Model pins exist in catalog',

  check(ctx: DoctorContext): DoctorCheckResult {
    if (!ctx.config || !ctx.catalog) {
      return { id: this.id, label: this.label, status: 'skip', detail: 'Config or catalog not loaded', fixable: false };
    }

    const models = [
      ctx.config.orchestrator.model,
      ...Object.values(ctx.config.executors).map((e) => e.model),
    ];
    const missing = [...new Set(models)].filter((m) => !ctx.catalog!.has(m));

    if (missing.length > 0) {
      return {
        id: this.id, label: this.label, status: 'fail',
        detail: `Unknown: ${missing.join(', ')}`,
        fixable: false,
      };
    }
    const unique = new Set(models).size;
    return {
      id: this.id, label: this.label, status: 'pass',
      detail: `${unique} pin${unique === 1 ? '' : 's'} OK`,
      fixable: false,
    };
  },
};
