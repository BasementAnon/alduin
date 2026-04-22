import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PolicyEngine } from './policy.js';
import type { PolicyContext } from './policy.js';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

function makeCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    channel: 'telegram',
    tenant_id: 'acme',
    user_id: 'user-1',
    user_role: 'member',
    is_group: false,
    session_id: 'sess-1',
    ...overrides,
  };
}

describe('PolicyEngine', () => {
  let tmpDir: string;
  let policyPath: string;
  let engine: PolicyEngine;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'alduin-policy-'));
    policyPath = join(tmpDir, 'policy.yaml');
  });

  afterEach(() => {
    engine?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('owner always gets the permissive default', () => {
    engine = new PolicyEngine();
    const verdict = engine.evaluate(makeCtx({ user_role: 'owner' }));
    expect(verdict.allowed).toBe(true);
    expect(verdict.allowed_skills).toContain('*');
    expect(verdict.model_tier_max).toBe('frontier');
  });

  it('admin always gets the permissive default', () => {
    engine = new PolicyEngine();
    const verdict = engine.evaluate(makeCtx({ user_role: 'admin' }));
    expect(verdict.allowed).toBe(true);
    expect(verdict.allowed_executors).toContain('*');
  });

  it('member in DM gets the default verdict', () => {
    engine = new PolicyEngine();
    const verdict = engine.evaluate(makeCtx({ user_role: 'member', is_group: false }));
    expect(verdict.allowed).toBe(true);
  });

  it('member in group gets restricted defaults (requires_confirmation set)', () => {
    engine = new PolicyEngine();
    const verdict = engine.evaluate(makeCtx({ user_role: 'member', is_group: true }));
    expect(verdict.allowed).toBe(true);
    expect(verdict.requires_confirmation.length).toBeGreaterThan(0);
    expect(verdict.requires_confirmation).toContain('file_write');
  });

  it('guest in DM gets the default (no custom rules)', () => {
    engine = new PolicyEngine();
    const verdict = engine.evaluate(makeCtx({ user_role: 'guest', is_group: false }));
    expect(verdict.allowed).toBe(true);
  });

  it('loads custom rules from a YAML file', () => {
    writeFileSync(policyPath, `
rules:
  - roles: [guest]
    scope: dm
    allowed: false
    denied_reason: "Guests cannot use this bot in DMs."
`, 'utf-8');

    engine = new PolicyEngine(policyPath);
    const verdict = engine.evaluate(makeCtx({ user_role: 'guest', is_group: false }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.denied_reason).toContain('Guests');
  });

  it('rules apply in order (later overrides earlier)', () => {
    writeFileSync(policyPath, `
rules:
  - roles: [member]
    cost_ceiling_usd: 0.50
  - roles: [member]
    scope: dm
    cost_ceiling_usd: 1.00
`, 'utf-8');

    engine = new PolicyEngine(policyPath);

    // In DM: second rule overrides → 1.00
    const dmVerdict = engine.evaluate(makeCtx({ user_role: 'member', is_group: false }));
    expect(dmVerdict.cost_ceiling_usd).toBe(1.0);

    // In group: first rule applies → 0.50 (second doesn't match DM scope)
    const groupVerdict = engine.evaluate(makeCtx({ user_role: 'member', is_group: true }));
    expect(groupVerdict.cost_ceiling_usd).toBe(0.5);
  });

  it('custom default overrides the built-in default', () => {
    writeFileSync(policyPath, `
default:
  cost_ceiling_usd: 0.10
  model_tier_max: cheap
`, 'utf-8');

    engine = new PolicyEngine(policyPath);
    // Non-admin users should get the custom default
    const verdict = engine.evaluate(makeCtx({ user_role: 'member' }));
    expect(verdict.cost_ceiling_usd).toBe(0.10);
    expect(verdict.model_tier_max).toBe('cheap');
  });

  it('addRule works for programmatic policy changes', () => {
    engine = new PolicyEngine();
    engine.addRule({
      roles: ['guest'],
      allowed: false,
      denied_reason: 'No guests allowed',
    });

    const verdict = engine.evaluate(makeCtx({ user_role: 'guest' }));
    expect(verdict.allowed).toBe(false);
  });

  // ── Privileged-role bypass behaviour ──────────────────────────────────────
  //
  // Default (privilegedBypassBudgets: false) — owners/admins still hit any
  // matching cost_ceiling_usd rule, so a compromised owner token cannot drain
  // the budget. Legacy behaviour is opt-in via the config flag.

  it('privileged roles still obey cost_ceiling_usd by default (bypass OFF)', () => {
    writeFileSync(policyPath, `
rules:
  - roles: [owner, admin]
    cost_ceiling_usd: 5.00
`, 'utf-8');

    engine = new PolicyEngine(policyPath); // options.privilegedBypassBudgets defaults to false

    const ownerVerdict = engine.evaluate(makeCtx({ user_role: 'owner' }));
    expect(ownerVerdict.allowed).toBe(true);
    expect(ownerVerdict.cost_ceiling_usd).toBe(5.0);

    const adminVerdict = engine.evaluate(makeCtx({ user_role: 'admin' }));
    expect(adminVerdict.allowed).toBe(true);
    expect(adminVerdict.cost_ceiling_usd).toBe(5.0);
  });

  it('privileged roles bypass ALL rules when privilegedBypassBudgets is true', () => {
    writeFileSync(policyPath, `
rules:
  - roles: [owner, admin]
    cost_ceiling_usd: 5.00
  - roles: [owner]
    allowed: false
    denied_reason: "Blocked"
`, 'utf-8');

    engine = new PolicyEngine(policyPath, { privilegedBypassBudgets: true });

    const ownerVerdict = engine.evaluate(makeCtx({ user_role: 'owner' }));
    expect(ownerVerdict.allowed).toBe(true);
    // Gets the permissive DEFAULT cost ceiling, not the rule's 5.00
    expect(ownerVerdict.cost_ceiling_usd).toBe(2.0);
    expect(ownerVerdict.denied_reason).toBeUndefined();
  });

  it('privileged roles are not blocked by non-cost deny rules (bypass OFF)', () => {
    // The privileged-but-budgeted branch only honors cost_ceiling_usd from
    // matching rules. Other fields (allowed:false, denied_reason, allowlists)
    // are intentionally ignored — privileged roles keep their base permissive
    // verdict, so an owner can't be locked out by a misconfigured rule.
    writeFileSync(policyPath, `
rules:
  - roles: [owner]
    allowed: false
    denied_reason: "Maintenance window"
`, 'utf-8');

    engine = new PolicyEngine(policyPath);

    const verdict = engine.evaluate(makeCtx({ user_role: 'owner' }));
    expect(verdict.allowed).toBe(true);
    expect(verdict.denied_reason).toBeUndefined();
  });

  // ── applies_to_privileged hardening (S1) ─────────────────────────────────

  it('applies_to_privileged:true blocks owner with allowed:false', () => {
    writeFileSync(policyPath, `
rules:
  - applies_to_privileged: true
    allowed: false
    denied_reason: "Maintenance window — all roles blocked"
`, 'utf-8');

    engine = new PolicyEngine(policyPath);

    const ownerVerdict = engine.evaluate(makeCtx({ user_role: 'owner' }));
    expect(ownerVerdict.allowed).toBe(false);
    expect(ownerVerdict.denied_reason).toContain('Maintenance window');

    const adminVerdict = engine.evaluate(makeCtx({ user_role: 'admin' }));
    expect(adminVerdict.allowed).toBe(false);
  });

  it('applies_to_privileged:true enforces cost_ceiling_usd AND other fields together', () => {
    writeFileSync(policyPath, `
rules:
  - applies_to_privileged: true
    cost_ceiling_usd: 3.00
    requires_confirmation: [delete]
`, 'utf-8');

    engine = new PolicyEngine(policyPath);

    const verdict = engine.evaluate(makeCtx({ user_role: 'owner' }));
    expect(verdict.cost_ceiling_usd).toBe(3.0);
    expect(verdict.requires_confirmation).toContain('delete');
    // allowed should remain true (rule doesn't set allowed:false)
    expect(verdict.allowed).toBe(true);
  });

  it('applies_to_privileged rule without the flag does NOT block owner (regression)', () => {
    // A rule that sets allowed:false but lacks applies_to_privileged must not
    // affect privileged roles — guards against accidental lockout.
    writeFileSync(policyPath, `
rules:
  - allowed: false
    denied_reason: "Only applies to non-privileged"
`, 'utf-8');

    engine = new PolicyEngine(policyPath);

    const ownerVerdict = engine.evaluate(makeCtx({ user_role: 'owner' }));
    expect(ownerVerdict.allowed).toBe(true);

    // But the same rule DOES apply to members
    const memberVerdict = engine.evaluate(makeCtx({ user_role: 'member' }));
    expect(memberVerdict.allowed).toBe(false);
  });

  it('cost_ceiling_usd from a non-applies_to_privileged rule still binds owners', () => {
    // Budget caps always apply regardless of applies_to_privileged flag.
    writeFileSync(policyPath, `
rules:
  - cost_ceiling_usd: 1.50
`, 'utf-8');

    engine = new PolicyEngine(policyPath);

    const verdict = engine.evaluate(makeCtx({ user_role: 'owner' }));
    expect(verdict.cost_ceiling_usd).toBe(1.5);
    expect(verdict.allowed).toBe(true);
  });
});
