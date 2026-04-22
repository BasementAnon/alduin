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
 * Truncate error messages for inclusion in a check result detail line —
 * the doctor UI renders these inline so they must stay one-line-ish.
 */
function truncate(text: string, max = 240): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? single.slice(0, max - 1) + '…' : single;
}

/**
 * Run a rule's `check()` with crash isolation.
 *
 * M-13: a single buggy or ill-configured rule (e.g. a child-process it
 * spawns throws ENOENT) must not be able to abort the entire doctor
 * run. We wrap every rule.check() in try/catch and on failure return a
 * synthesized `fail` result carrying the error message, so the operator
 * still gets the full picture of every other rule.
 */
async function runCheckSafely(
  rule: DoctorRule,
  ctx: DoctorContext,
): Promise<DoctorCheckResult> {
  try {
    return await rule.check(ctx);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      id: rule.id,
      label: rule.label,
      status: 'fail',
      detail: `Check crashed: ${truncate(msg)}`,
      // Never auto-remediate a crashed rule — we don't know what state
      // the process is in.
      fixable: false,
    };
  }
}

/**
 * Run a rule's `fix()` with crash isolation.
 *
 * Same rationale as runCheckSafely: one fix raising an exception must
 * not abort the rest of the fix pass. The returned log line surfaces
 * the crash to the operator so they can investigate manually.
 */
async function runFixSafely(
  rule: DoctorRule,
  ctx: DoctorContext,
): Promise<string | null> {
  if (!rule.fix) return null;
  try {
    return await rule.fix(ctx);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `[${rule.id}] fix crashed: ${truncate(msg)}`;
  }
}

/**
 * Run all rules against a shared context.
 *
 * When `ctx.fix` is true the runner:
 * 1. Runs all checks
 * 2. Calls fix() on every fixable non-pass check
 * 3. Re-runs all checks
 * 4. Marks checks that transitioned to 'pass' as 'fixed'
 *
 * Each check/fix invocation is isolated with try/catch (M-13) so a
 * single misbehaving rule cannot abort the overall run.
 */
export async function runRules(
  rules: DoctorRule[],
  ctx: DoctorContext,
): Promise<RunnerResult> {
  // First pass — gather initial results
  const initial: DoctorCheckResult[] = [];
  for (const rule of rules) {
    initial.push(await runCheckSafely(rule, ctx));
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
      const msg = await runFixSafely(rule, ctx);
      if (msg) fixLog.push(msg);
    }
  }

  // Re-run checks after fixes
  const fresh: DoctorCheckResult[] = [];
  for (const rule of rules) {
    fresh.push(await runCheckSafely(rule, ctx));
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
