/**
 * Doctor rule runner — collects rules, runs checks, applies fixes.
 *
 */

import type { DoctorRule, DoctorCheckResult, DoctorContext, CheckStatus } from './rule.js';

export interface RunnerResult {
  checks: DoctorCheckResult[];
  fixLog: string[];
}

/**
 * Run all rules against a shared context.
 *
 * When `ctx.fix` is true the runner:
 * 1. Runs all checks
 * 2. Calls fix() on every fixable non-pass check
 * 3. Re-runs all checks
 * 4. Marks checks that transitioned to 'pass' as 'fixed'
 */
export async function runRules(
  rules: DoctorRule[],
  ctx: DoctorContext,
): Promise<RunnerResult> {
  // First pass — gather initial results
  const initial: DoctorCheckResult[] = [];
  for (const rule of rules) {
    initial.push(await rule.check(ctx));
  }

  if (!ctx.fix) {
    return { checks: initial, fixLog: [] };
  }

  // Apply fixes
  const fixLog: string[] = [];
  for (let i = 0; i < rules.length; i++) {
    const result = initial[i]!;
    const rule = rules[i]!;

    if (
      result.fixable &&
      result.status !== 'pass' &&
      result.status !== 'skip' &&
      rule.fix
    ) {
      const msg = await rule.fix(ctx);
      if (msg) fixLog.push(msg);
    }
  }

  // Re-run checks after fixes
  const fresh: DoctorCheckResult[] = [];
  for (const rule of rules) {
    fresh.push(await rule.check(ctx));
  }

  // Mark healed checks as 'fixed'
  const checks = fresh.map((freshCheck, i) => {
    const orig = initial[i]!;
    if (
      orig.status !== 'pass' &&
      orig.status !== 'skip' &&
      freshCheck.status === 'pass'
    ) {
      return {
        ...freshCheck,
        status: 'fixed' as CheckStatus,
        detail: `Fixed: ${freshCheck.detail || orig.detail}`,
      };
    }
    return freshCheck;
  });

  return { checks, fixLog };
}
