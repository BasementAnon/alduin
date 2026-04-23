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
  catalog?: ModelCatalog | null
): Promise<BudgetAnswers> {
  const rawDaily = guard(
    await text({
      message: 'Daily global budget in USD:',
      placeholder: '10.00',
      initialValue: '10.00',
      validate: (v) => {
        if (!v || parsePositiveFloat(v) === undefined) return 'Must be a positive number (e.g. 10.00)';
        return undefined;
      },
    })
  );
  const dailyLimitUsd = parsePositiveFloat((rawDaily as string) || '10') ?? 10;

  const rawThreshold = guard(
    await text({
      message: 'Warning threshold (fraction of daily limit, 0–1):',
      placeholder: '0.8',
      initialValue: '0.8',
      validate: (v) => {
        if (!v || parseThreshold(v) === undefined) return 'Must be between 0 and 1 (e.g. 0.8)';
        return undefined;
      },
    })
  );
  const warningThreshold = parseThreshold((rawThreshold as string) || '0.8') ?? 0.8;

  const rawPerTask = guard(
    await text({
      message: 'Per-task spending limit in USD:',
      placeholder: '2.00',
      initialValue: '2.00',
      validate: (v) => {
        if (!v || parsePositiveFloat(v) === undefined) return 'Must be a positive number (e.g. 2.00)';
        const n = parsePositiveFloat(v);
        if (n !== undefined && n > dailyLimitUsd) return `Cannot exceed daily limit ($${dailyLimitUsd.toFixed(2)})`;
        return undefined;
      },
    })
  );
  const perTaskLimitUsd = parsePositiveFloat((rawPerTask as string) || '2') ?? 2;

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
