/**
 * Rule: models-deprecated — warns on deprecated model pins, suggests successors.
 *
 * This rule is NOT auto-fixable — it requires the user to explicitly
 * run `alduin models upgrade` so they can review the substitution.
 */

import type { DoctorRule, DoctorCheckResult, DoctorContext } from '../rule.js';

/**
 * Known model successor map.
 * Keys: deprecated model strings. Values: suggested replacement.
 * Maintained manually; the catalog doesn't carry successor metadata.
 */
const MODEL_SUCCESSORS: Record<string, string> = {
  'anthropic/claude-3-opus-20240229': 'anthropic/claude-opus-4-20250514',
  'anthropic/claude-3-sonnet-20240229': 'anthropic/claude-sonnet-4-20250514',
  'anthropic/claude-3-haiku-20240307': 'anthropic/claude-haiku-4-5-20251001',
  'anthropic/claude-3.5-sonnet-20240620': 'anthropic/claude-sonnet-4-20250514',
  'openai/gpt-4-turbo-preview': 'openai/gpt-4.1',
  'openai/gpt-4-0125-preview': 'openai/gpt-4.1',
  'openai/gpt-3.5-turbo': 'openai/gpt-4.1-mini',
};

export const modelsDeprecatedRule: DoctorRule = {
  id: 'models-not-deprecated',
  label: 'No deprecated model pins',

  check(ctx: DoctorContext): DoctorCheckResult {
    if (!ctx.config || !ctx.catalog) {
      return { id: this.id, label: this.label, status: 'skip', detail: 'Config or catalog not loaded', fixable: false };
    }

    const models = [
      ctx.config.orchestrator.model,
      ...Object.values(ctx.config.executors).map((e) => e.model),
    ];
    const deprecated = [...new Set(models)].filter((m) => ctx.catalog!.isDeprecated(m));

    if (deprecated.length === 0) {
      return { id: this.id, label: this.label, status: 'pass', detail: '', fixable: false };
    }

    // Build suggestion strings
    const suggestions = deprecated.map((m) => {
      const successor = MODEL_SUCCESSORS[m];
      return successor ? `${m} → ${successor}` : m;
    });

    return {
      id: this.id, label: this.label, status: 'warn',
      detail: `Deprecated: ${suggestions.join('; ')} — run \`alduin models upgrade\``,
      fixable: false, // intentionally not fixable
    };
  },

  // No fix() — user must run `alduin models upgrade` explicitly
};
