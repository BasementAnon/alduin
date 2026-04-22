import { confirm, log, text } from '@clack/prompts';
import type { BudgetConfig } from '../../../config/schema/index.js';
import { guard } from '../helpers.js';
import type { BudgetAnswers } from '../types.js';

// ── Pure builders (tested) ────────────────────────────────────────────────────

/**
 * Build the `budgets` section of AlduinConfig from wizard answers.
 *
 * @param answers - Budget parameters from the wizard.
 * @returns A complete BudgetConfig ready to merge into the root config.
 */
export function buildBudgetConfig(answers: BudgetAnswers): BudgetConfig {
  const budget: BudgetConfig = {
    daily_limit_usd: answers.dailyLimitUsd,
    per_task_limit_usd: Math.min(2, answers.dailyLimitUsd * 0.2),
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

// ── UI (not tested directly) ──────────────────────────────────────────────────

/**
 * Step 4 — set budget limits.
 * Prompts for daily limit and warning threshold; offers optional per-model
 * overrides for advanced users.
 * Throws WizardCancelledError on Ctrl-C.
 */
export async function runBudget(): Promise<BudgetAnswers> {
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

  log.info(
    `Per-task limit auto-set to $${Math.min(2, dailyLimitUsd * 0.2).toFixed(2)} ` +
      `(20% of daily, capped at $2.00).`
  );

  // Optional per-model overrides
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

  return { dailyLimitUsd, warningThreshold, perModelLimits };
}
