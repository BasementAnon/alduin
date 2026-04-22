import { describe, it, expect } from 'vitest';
import { runRules } from './runner.js';
import type { DoctorRule, DoctorContext, DoctorCheckResult } from './rule.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeCtx(fix = false): DoctorContext {
  return {
    configPath: '/tmp/nonexistent-config.yaml',
    vaultPath: '/tmp/nonexistent-vault.db',
    root: '/tmp',
    config: null,
    catalog: null,
    env: {},
    skipVault: true,
    fix,
  };
}

/** A rule that returns a fixed result. */
function passRule(id: string): DoctorRule {
  return {
    id,
    label: id,
    check(): DoctorCheckResult {
      return { id, label: id, status: 'pass', detail: '', fixable: false };
    },
  };
}

/** A rule whose check() throws. */
function crashingRule(id: string, message: string): DoctorRule {
  return {
    id,
    label: id,
    check(): DoctorCheckResult {
      throw new Error(message);
    },
  };
}

/** A rule with a fixable failure whose fix() throws. */
function crashingFixRule(id: string): DoctorRule {
  let healed = false;
  return {
    id,
    label: id,
    check(): DoctorCheckResult {
      return {
        id,
        label: id,
        status: healed ? 'pass' : 'fail',
        detail: healed ? '' : 'needs fix',
        fixable: true,
      };
    },
    fix(): string {
      throw new Error('fix-went-wrong');
    },
  };
}

/** A rule with a fixable failure whose fix() succeeds. */
function fixableRule(id: string): DoctorRule {
  let healed = false;
  return {
    id,
    label: id,
    check(): DoctorCheckResult {
      return {
        id,
        label: id,
        status: healed ? 'pass' : 'fail',
        detail: healed ? '' : 'needs fix',
        fixable: true,
      };
    },
    fix(): string {
      healed = true;
      return `${id} fixed`;
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('runRules — crash isolation (M-13)', () => {
  it('a crashing check does not abort the run', async () => {
    const rules = [
      passRule('a'),
      crashingRule('b', 'kaboom'),
      passRule('c'),
    ];
    const result = await runRules(rules, makeCtx());
    expect(result.checks).toHaveLength(3);
    expect(result.checks[0]!.status).toBe('pass');
    expect(result.checks[1]!.status).toBe('fail');
    expect(result.checks[1]!.detail).toMatch(/Check crashed/);
    expect(result.checks[1]!.detail).toContain('kaboom');
    expect(result.checks[2]!.status).toBe('pass');
  });

  it('a crashing rule is marked non-fixable so the auto-fix pass skips it', async () => {
    const rules = [crashingRule('x', 'no')];
    const result = await runRules(rules, makeCtx(true));
    expect(result.checks[0]!.fixable).toBe(false);
    expect(result.fixLog).toEqual([]);
  });

  it('a crashing fix does not abort the fix pass', async () => {
    const rules = [
      fixableRule('a'),
      crashingFixRule('b'),
      fixableRule('c'),
    ];
    const result = await runRules(rules, makeCtx(true));

    // Two fixes succeeded, one crashed — the crash shows up in fixLog.
    const crashEntry = result.fixLog.find((l) => l.includes('[b]'));
    expect(crashEntry).toBeDefined();
    expect(crashEntry).toMatch(/fix crashed/);
    expect(crashEntry).toContain('fix-went-wrong');

    // The successful fixes should have re-checked as 'fixed'.
    const a = result.checks.find((c) => c.id === 'a');
    const c = result.checks.find((c) => c.id === 'c');
    expect(a!.status).toBe('fixed');
    expect(c!.status).toBe('fixed');
  });

  it('truncates very long error messages in the check detail', async () => {
    const longMsg = 'x'.repeat(1000);
    const rules = [crashingRule('long', longMsg)];
    const result = await runRules(rules, makeCtx());
    // The detail must be bounded so the doctor UI stays readable.
    expect(result.checks[0]!.detail.length).toBeLessThan(300);
    expect(result.checks[0]!.detail.endsWith('…')).toBe(true);
  });

  it('returns a synthetic fail result carrying the rule id and label', async () => {
    const rules = [crashingRule('my-rule-id', 'fail msg')];
    const result = await runRules(rules, makeCtx());
    expect(result.checks[0]!.id).toBe('my-rule-id');
    expect(result.checks[0]!.label).toBe('my-rule-id');
    expect(result.checks[0]!.status).toBe('fail');
  });
});

describe('runRules — normal behaviour', () => {
  it('runs all checks and returns their results', async () => {
    const rules = [passRule('a'), passRule('b')];
    const result = await runRules(rules, makeCtx());
    expect(result.checks).toHaveLength(2);
    expect(result.fixLog).toEqual([]);
  });

  it('does not call fix() when ctx.fix is false', async () => {
    const rules = [fixableRule('a')];
    const result = await runRules(rules, makeCtx(false));
    // The fixable rule reports 'fail', not 'fixed'.
    expect(result.checks[0]!.status).toBe('fail');
    expect(result.fixLog).toEqual([]);
  });

  it('fixes healable rules and marks them as fixed', async () => {
    const rules = [fixableRule('a')];
    const result = await runRules(rules, makeCtx(true));
    expect(result.checks[0]!.status).toBe('fixed');
    expect(result.fixLog).toContain('a fixed');
  });
});
