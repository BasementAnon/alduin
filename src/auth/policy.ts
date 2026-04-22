import { readFileSync, existsSync, watchFile, unwatchFile } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { AttachmentRef } from '../channels/adapter.js';
import type { UserRole } from './roles.js';

/*
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │  DESIGN NOTE: Privileged Role Policy Bypass (pending product decision)     │
 * │                                                                            │
 * │  Currently, evaluate() short-circuits for owner/admin roles — they always  │
 * │  get the permissive default verdict. This means a compromised owner        │
 * │  account bypasses ALL cost ceilings, per-rule denials, and model-tier      │
 * │  restrictions. A stolen bot-admin token becomes an unlimited spend vector. │
 * │                                                                            │
 * │  Proposed hardening (requires product sign-off):                           │
 * │                                                                            │
 * │  1. Owners still get `allowed: true` by default — no change to basic      │
 * │     access grant.                                                          │
 * │                                                                            │
 * │  2. Rules gain an `applies_to_privileged: boolean` flag (default false).   │
 * │     When true, the rule evaluates against owner/admin roles too.           │
 * │     Example use case:                                                      │
 * │       - { applies_to_privileged: true, cost_ceiling_usd: 50.0 }           │
 * │       - { applies_to_privileged: true, allowed: false,                    │
 * │           denied_reason: "Maintenance window" }                            │
 * │                                                                            │
 * │  3. `cost_ceiling_usd` always applies regardless of role. Even owners     │
 * │     should hit the global daily hard-stop. This is a safety net against    │
 * │     both compromised accounts and accidental infinite loops.               │
 * │                                                                            │
 * │  Trade-offs:                                                               │
 * │  + Compromised admin can't drain the budget beyond the ceiling.            │
 * │  + Operators can set maintenance-mode rules that block everyone.           │
 * │  + Cost ceiling as a universal guardrail prevents runaway pipelines.       │
 * │  − Owners who legitimately need to exceed limits (e.g. one-time bulk      │
 * │    import) would need a "budget override" command or temporary rule.       │
 * │  − More complex rule evaluation: every rule needs the privileged check.    │
 * │  − Breaking change: existing deployments where owners expect unlimited     │
 * │    access would need a migration or an explicit opt-in config flag.        │
 * │                                                                            │
 * │  Implementation path:                                                      │
 * │  a. Add `applies_to_privileged?: boolean` to PolicyRule interface.         │
 * │  b. Remove the early return at line ~107.                                  │
 * │  c. Start with the default verdict (allowed: true for owner/admin).        │
 * │  d. Apply ALL rules, but skip non-privileged rules for owner/admin.        │
 * │  e. Always apply cost_ceiling_usd from the default verdict, regardless    │
 * │     of role.                                                               │
 * │  f. Add a config flag `policy.privileged_bypass: true` (default true)     │
 * │     for backward compat; when true, the current behaviour is preserved.   │
 * └─────────────────────────────────────────────────────────────────────────────┘
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PolicyContext {
  channel: string;
  tenant_id: string;
  user_id: string;
  user_role: UserRole;
  is_group: boolean;
  session_id: string;
}

export interface PolicyVerdict {
  allowed: boolean;
  denied_reason?: string;
  allowed_skills: string[];
  allowed_tools: string[];
  allowed_connectors: string[];
  allowed_executors: string[];
  cost_ceiling_usd: number;
  model_tier_max: 'local' | 'cheap' | 'standard' | 'frontier';
  allowed_attachment_kinds: AttachmentRef['kind'][];
  requires_confirmation: string[];
  /** Maximum recursion depth this policy allows. Overrides per-task max_depth. */
  max_recursion_depth?: number;
  /** Per-session kill switch. When true, all sub-orchestration is blocked. */
  recursion_disabled?: boolean;
}

export const DEFAULT_POLICY_VERDICT: PolicyVerdict = {
  allowed: true,
  allowed_skills: ['*'],
  allowed_tools: ['*'],
  allowed_connectors: ['*'],
  allowed_executors: ['*'],
  cost_ceiling_usd: 2.0,
  model_tier_max: 'frontier',
  allowed_attachment_kinds: ['image', 'document', 'audio', 'voice', 'video', 'url'],
  requires_confirmation: [],
  max_recursion_depth: 2,
  recursion_disabled: false,
};

// ── Policy rule shape (loaded from YAML) ──────────────────────────────────────

interface PolicyRule {
  /** Which roles this rule applies to (empty = all) */
  roles?: UserRole[];
  /** Which channels (empty = all) */
  channels?: string[];
  /** Whether this applies in groups, DMs, or both */
  scope?: 'group' | 'dm' | 'all';
  /**
   * When true, this rule is evaluated against owner/admin roles too.
   * Defaults to false — privileged roles skip non-privileged rules.
   * Use with `allowed: false` for maintenance windows, or with
   * `cost_ceiling_usd` for hard budget caps that apply to everyone.
   */
  applies_to_privileged?: boolean;
  /** Overrides on the verdict */
  allowed?: boolean;
  denied_reason?: string;
  allowed_skills?: string[];
  allowed_tools?: string[];
  allowed_connectors?: string[];
  allowed_executors?: string[];
  cost_ceiling_usd?: number;
  model_tier_max?: PolicyVerdict['model_tier_max'];
  allowed_attachment_kinds?: AttachmentRef['kind'][];
  requires_confirmation?: string[];
}

interface PolicyFile {
  default?: Partial<PolicyVerdict>;
  rules?: PolicyRule[];
}

// ── PolicyEngine ──────────────────────────────────────────────────────────────

/**
 * Policy engine — evaluates a context against a YAML policy file.
 * The file is hot-reloadable (watches for changes).
 *
 * Default behaviour: group chats deny writes unless explicitly allowed.
 * Owner and admin roles get the permissive default verdict.
 */
export interface PolicyEngineOptions {
  /**
   * When true, owner/admin roles bypass ALL policy rules — including
   * cost_ceiling_usd. Legacy behaviour; defaults to false.
   *
   * When false, owner/admin roles skip allowlist / tier / denial rules but
   * still obey any matching rule that sets `cost_ceiling_usd`. The default
   * verdict's cost_ceiling_usd also still applies.
   */
  privilegedBypassBudgets?: boolean;
}

export class PolicyEngine {
  private rules: PolicyRule[] = [];
  private defaultVerdict: PolicyVerdict;
  private filePath: string | null = null;
  private privilegedBypassBudgets: boolean;

  constructor(policyFilePath?: string, options: PolicyEngineOptions = {}) {
    this.defaultVerdict = { ...DEFAULT_POLICY_VERDICT };
    this.privilegedBypassBudgets = options.privilegedBypassBudgets ?? false;

    if (policyFilePath) {
      this.filePath = policyFilePath;
      this.loadFromFile(policyFilePath);

      // Hot-reload on file change (2s poll for portability)
      if (existsSync(policyFilePath)) {
        watchFile(policyFilePath, { interval: 2000 }, () => {
          this.loadFromFile(policyFilePath);
        });
      }
    }
  }

  /**
   * Evaluate a context and produce a PolicyVerdict.
   *
   * Evaluation order:
   * 1. Start with the default verdict
   * 2. Owners and admins get the permissive default for allowlist/tier/denial
   *    fields, but any matching rule that sets `cost_ceiling_usd` still
   *    applies to them (unless `privilegedBypassBudgets` is true, in which
   *    case they bypass all rules — legacy behaviour, opt-in)
   * 3. Apply matching rules in order for non-privileged roles
   *    (later rules override earlier)
   * 4. Group chats default-deny writes unless a rule explicitly allows
   */
  evaluate(context: PolicyContext): PolicyVerdict {
    const isPrivileged =
      context.user_role === 'owner' || context.user_role === 'admin';

    // Legacy full-bypass: opt-in via `auth.privileged_bypass_budgets: true`.
    if (isPrivileged && this.privilegedBypassBudgets) {
      return { ...this.defaultVerdict, allowed: true };
    }

    // Privileged-but-hardened: start with the permissive default, then apply
    // any rule that (a) matches the context AND either (b1) explicitly opts in
    // via `applies_to_privileged: true` OR (b2) sets `cost_ceiling_usd` (which
    // always binds every role to prevent runaway spend on compromised tokens).
    if (isPrivileged) {
      let verdict: PolicyVerdict = { ...this.defaultVerdict, allowed: true };
      for (const rule of this.rules) {
        if (!this.ruleMatches(rule, context)) continue;
        if (rule.applies_to_privileged) {
          // Full rule application — includes allowed:false, requires_confirmation, etc.
          verdict = this.applyRule(verdict, rule);
        } else if (rule.cost_ceiling_usd !== undefined) {
          // Budget cap always applies regardless of applies_to_privileged flag.
          verdict = { ...verdict, cost_ceiling_usd: rule.cost_ceiling_usd };
        }
      }
      return verdict;
    }

    let verdict: PolicyVerdict = { ...this.defaultVerdict };

    // Group default: restrict executors to read-only tasks
    if (context.is_group) {
      verdict = {
        ...verdict,
        allowed_executors: ['code', 'research', 'content', 'quick', 'classifier'],
        requires_confirmation: ['file_write', 'email_send', 'delete'],
      };
    }

    // Apply matching rules
    for (const rule of this.rules) {
      if (!this.ruleMatches(rule, context)) continue;
      verdict = this.applyRule(verdict, rule);
    }

    return verdict;
  }

  /** Stop watching the policy file */
  close(): void {
    if (this.filePath && existsSync(this.filePath)) {
      unwatchFile(this.filePath);
    }
  }

  /** Programmatically add a rule (used by /alduin policy commands) */
  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
  }

  /** Get all current rules (for /alduin policy show) */
  getRules(): PolicyRule[] {
    return [...this.rules];
  }

  private loadFromFile(filePath: string): void {
    if (!existsSync(filePath)) return;
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = parseYaml(raw, { maxAliasCount: 100 }) as PolicyFile;

      if (parsed.default) {
        this.defaultVerdict = { ...DEFAULT_POLICY_VERDICT, ...parsed.default };
      }
      this.rules = parsed.rules ?? [];
    } catch (err) {
      console.warn(
        `[PolicyEngine] Failed to load policy file: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private ruleMatches(rule: PolicyRule, context: PolicyContext): boolean {
    if (rule.roles && rule.roles.length > 0 && !rule.roles.includes(context.user_role)) {
      return false;
    }
    if (rule.channels && rule.channels.length > 0 && !rule.channels.includes(context.channel)) {
      return false;
    }
    if (rule.scope === 'group' && !context.is_group) return false;
    if (rule.scope === 'dm' && context.is_group) return false;
    return true;
  }

  private applyRule(verdict: PolicyVerdict, rule: PolicyRule): PolicyVerdict {
    return {
      ...verdict,
      ...(rule.allowed !== undefined ? { allowed: rule.allowed } : {}),
      ...(rule.denied_reason ? { denied_reason: rule.denied_reason } : {}),
      ...(rule.allowed_skills ? { allowed_skills: rule.allowed_skills } : {}),
      ...(rule.allowed_tools ? { allowed_tools: rule.allowed_tools } : {}),
      ...(rule.allowed_connectors ? { allowed_connectors: rule.allowed_connectors } : {}),
      ...(rule.allowed_executors ? { allowed_executors: rule.allowed_executors } : {}),
      ...(rule.cost_ceiling_usd !== undefined ? { cost_ceiling_usd: rule.cost_ceiling_usd } : {}),
      ...(rule.model_tier_max ? { model_tier_max: rule.model_tier_max } : {}),
      ...(rule.allowed_attachment_kinds ? { allowed_attachment_kinds: rule.allowed_attachment_kinds } : {}),
      ...(rule.requires_confirmation ? { requires_confirmation: rule.requires_confirmation } : {}),
    };
  }
}
