/**
 * Step 4 — Budget configuration.
 *
 * Prompts for:
 *   - Daily spend limit (default $10)
 *   - Warning threshold (default 80%)
 *   - Per-task limit (default $2)
 *   - Optional per-model daily caps
 *
 * Shows estimated daily call capacity based on model pricing.
 */

import { confirm, log, note, text } from '@clack/prompts';
import type { BudgetConfig } from '../../../config/schema/index.js';
import type { ModelCatalog } from '../../../catalog/catalog.js';
import { guard } from '../helpers.js';
import type { BudgetAnswers, ModelAnswers } from '../types.js';

// ── Pure builders (tested) ────────────────────────────────────────────────────

export function buildBudgetConfig(answers: BudgetAnswers): BudgetConfig {
  const budget: BudgetConfig = {
    daily_limit_usd: answers.dailyLimitUsd,
    per_task_limit_usd: answers.perTaskLimitUsd,
    warning_threshold: answers.warningThreshold,
  };

  if (answers.perModelLimits && Object.keys(answers.perModelLimits).length > 0) {
    budget.per_model_limits = answers.perModelLimits;
  }

  return budget;
}

// ── Validation helpers ────────────────────────────────────────────────────────

function parsePositiveFloat(raw: string): number | undefined {
  const n = parseFloat(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseNonNegativeFloat(raw: string): number | undefined {
  const n = parseFloat(raw.trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function parseThreshold(raw: string): number | undefined {
  const n = parseFloat(raw.trim());
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}

// ── Usage estimation ──────────────────────────────────────────────────────────

function estimateCallCapacity(
  dailyLimit: number,
  orchestratorModel: string,
  classifierModel: string,
  catalog: ModelCatalog | null
): string {
  const orchPricing = catalog?.getPricing(orchestratorModel);
  const classPricing = catalog?.getPricing(classifierModel);

  if (!orchPricing || !classPricing) {
    return 'Cannot estimate — model pricing data unavailable.';
  }

  // Estimate cost per orchestrator call (~2000 input, ~1000 output tokens)
  const orchCost = (2000 * orchPricing.input + 1000 * orchPricing.output) / 1_000_000;
  // Estimate cost per classifier call (~200 input, ~50 output tokens)
  const classCost = (200 * classPricing.input + 50 * classPricing.output) / 1_000_000;

  const orchCalls = orchCost > 0 ? Math.floor(dailyLimit / orchCost) : Infinity;
  const classCalls = classCost > 0 ? Math.floor(dailyLimit / classCost) : Infinity;

  const orchStr = orchCalls === Infinity ? '∞' : `~${orchCalls}`;
  const classStr = classCalls === Infinity ? '∞' : `~${classCalls}`;

  return (
    `At $${dailyLimit.toFixed(2)}/day, you can run approximately:\n` +
    `  ${orchStr} orchestrator calls ($${orchCost.toFixed(4)}/call)\n` +
    `  ${classStr} classifier calls ($${classCost.toFixed(4)}/call)`
  );
}

// ── UI ────────────────────────────────────────────────────────────────────────

export async function runBudget(
  modelAnswers?: ModelAnswers,
  catalog?: ModelCatalog | null,
  existing?: Partial<BudgetAnswers>
): Promise<BudgetAnswers> {
  // ── Daily budget opt-in ───────────────────────────────────────────────────
  const wantsDaily = guard(
    await confirm({
      message: 'Set a daily global spend limit? (recommended)',
      initialValue: existing !== undefined ? (existing.dailyLimitUsd ?? 0) > 0 : true,
    })
  );

  let dailyLimitUsd = 0;
  let warningThreshold = 0;

  if (wantsDaily) {
    // Recommendation table (items 3)
    note(
      'Suggested daily budgets:\n\n' +
        '  Personal / hobby  $2   A few dozen Claude Sonnet round-trips per day\n' +
        '  Power user / dev  $10  Hundreds of round-trips, room for occasional Opus\n' +
        '  Team / production $50  Sustained throughput, fallback chains active',
      'Suggested daily budgets'
    );

    const defaultDailyStr = existing?.dailyLimitUsd && existing.dailyLimitUsd > 0
      ? String(existing.dailyLimitUsd.toFixed(2))
      : '10.00';

    const rawDaily = guard(
      await text({
        message: 'Daily global budget in USD:',
        placeholder: '10.00',
        initialValue: defaultDailyStr,
        validate: (v) => {
          if (!v || parsePositiveFloat(v) === undefined) return 'Must be a positive number (e.g. 10.00)';
          return undefined;
        },
      })
    );
    dailyLimitUsd = parsePositiveFloat((rawDaily as string) || '10') ?? 10;

    const defaultThresholdStr = existing?.warningThreshold !== undefined
      ? String(existing.warningThreshold)
      : '0.8';

    const rawThreshold = guard(
      await text({
        message: 'Warning threshold as a fraction of the daily limit (e.g. 0.8 = warn at 80%):',
        placeholder: '0.8',
        initialValue: defaultThresholdStr,
        validate: (v) => {
          if (!v || parseThreshold(v) === undefined)
            return 'Must be a fraction between 0 and 1 — e.g. 0.8 means warn when 80% of the daily budget is used.';
          return undefined;
        },
      })
    );
    warningThreshold = parseThreshold((rawThreshold as string) || '0.8') ?? 0.8;
    log.info(`Will warn at ${(warningThreshold * 100).toFixed(0)}% of daily limit ($${(dailyLimitUsd * warningThreshold).toFixed(2)}).`);

    // Show usage estimate
    if (modelAnswers && catalog) {
      const estimate = estimateCallCapacity(
        dailyLimitUsd,
        modelAnswers.assignments.orchestrator,
        modelAnswers.assignments.classifier,
        catalog
      );
      note(estimate, 'Estimated daily capacity');
    }
  }

  // ── Per-task limit (opt-in, always shown) — see item #4 ──────────────────
  // NOTE: per-task tier recommendations and logic are in item #4 (runBudget
  // currently handles per-task inline; they will be refactored in that item).
  const wantsPerTask = guard(
    await confirm({
      message: 'Set a per-task spending cap? (recommended even without a daily budget)',
      initialValue: existing !== undefined ? (existing.perTaskLimitUsd ?? 0) > 0 : true,
    })
  );

  let perTaskLimitUsd = 0;
  if (wantsPerTask) {
    const defaultPerTaskStr = existing?.perTaskLimitUsd && existing.perTaskLimitUsd > 0
      ? String(existing.perTaskLimitUsd.toFixed(2))
      : '0.50';

    const rawPerTask = guard(
      await text({
        message: 'Per-task spending limit in USD:',
        placeholder: '0.50',
        initialValue: defaultPerTaskStr,
        validate: (v) => {
          if (!v || parseNonNegativeFloat(v) === undefined)
            return 'Must be a non-negative number (e.g. 0.50)';
          const n = parseNonNegativeFloat(v);
          if (n !== undefined && dailyLimitUsd > 0 && n > dailyLimitUsd)
            return `Cannot exceed daily limit ($${dailyLimitUsd.toFixed(2)})`;
          return undefined;
        },
      })
    );
    perTaskLimitUsd = parseNonNegativeFloat((rawPerTask as string) || '0.50') ?? 0.5;
  }

  const wantsPerModel = guard(
    await confirm({
      message: 'Add per-model spending caps? (advanced — usually not needed)',
      initialValue: false,
    })
  );

  let perModelLimits: Record<string, number> | undefined;
  if (wantsPerModel) {
    perModelLimits = {};
    log.info(
      'Enter model caps one per line. Press Enter with an empty model name to finish.\n' +
        '  Format: provider/model-name = daily-limit-usd (e.g. anthropic/claude-opus-4-6 = 3)'
    );

    let keepAdding = true;
    while (keepAdding) {
      const rawEntry = guard(
        await text({
          message: 'Model cap (leave empty to finish):',
          placeholder: 'anthropic/claude-opus-4-6 = 3.00',
        })
      ) as string;

      if (!rawEntry.trim()) {
        keepAdding = false;
        break;
      }

      const [modelPart, limitPart] = rawEntry.split('=');
      const model = modelPart?.trim();
      const limit = parsePositiveFloat(limitPart?.trim() ?? '');

      if (model && limit !== undefined) {
        perModelLimits[model] = limit;
        log.success(`  Added cap: ${model} → $${limit.toFixed(2)}/day`);
      } else {
        log.warn('  Could not parse entry — use format: model/name = limit');
      }
    }

    if (Object.keys(perModelLimits).length === 0) {
      perModelLimits = undefined;
    }
  }

  return { dailyLimitUsd, warningThreshold, perTaskLimitUsd, perModelLimits };
}
