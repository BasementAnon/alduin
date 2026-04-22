/**
 * Admin command tests that don't depend on better-sqlite3.
 * Uses mock deps to test command parsing, role enforcement, and audit emission.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAdminCommand } from './admin.js';
import type { AdminCommandContext, AdminDeps } from './admin.js';

function makeCtx(role: 'owner' | 'admin' | 'member' | 'guest' = 'owner'): AdminCommandContext {
  return {
    tenant_id: 'acme',
    user_id: 'user-1',
    user_role: role,
    session_id: 'sess-1',
    is_group: false,
  };
}

function makeDeps(overrides: Partial<AdminDeps> = {}): AdminDeps {
  return {
    roleResolver: {} as any,
    policyEngine: {
      getRules: vi.fn().mockReturnValue([]),
      addRule: vi.fn(),
    } as any,
    auditLog: {
      log: vi.fn(),
    } as any,
    budgetTracker: {
      getDailySummary: vi.fn().mockReturnValue({
        per_model: new Map(),
        total_cost: 1.5,
        budget_remaining: 8.5,
      }),
      setDailyLimit: vi.fn(),
      setWarningThreshold: vi.fn(),
      setPerModelLimit: vi.fn(),
    } as any,
    scopedBudget: {
      getScopedSpend: vi.fn().mockReturnValue(0.5),
      setScopedLimit: vi.fn(),
    } as any,
    traceLogger: {
      formatTraceTree: vi.fn().mockReturnValue('Trace output'),
    } as any,
    startedAt: new Date(),
    activeSessionCount: () => 3,
    ...overrides,
  };
}

describe('admin command parsing (no SQLite)', () => {
  let deps: AdminDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  // ── Role enforcement ───────────────────────────────────────────────────

  it('denies member from all admin commands', () => {
    const result = handleAdminCommand('/alduin plugins list', makeCtx('member'), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('owner or admin');
  });

  it('denies guest from all admin commands', () => {
    const result = handleAdminCommand('/alduin models list', makeCtx('guest'), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('owner or admin');
  });

  it('allows admin role', () => {
    const result = handleAdminCommand('/alduin status', makeCtx('admin'), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('Alduin');
  });

  // ── Help text ──────────────────────────────────────────────────────────

  it('bare /alduin shows help with all commands', () => {
    const result = handleAdminCommand('/alduin', makeCtx(), deps);
    expect(result.reply).toContain('budget');
    expect(result.reply).toContain('policy');
    expect(result.reply).toContain('trace');
    expect(result.reply).toContain('recursion');
    expect(result.reply).toContain('models');
    expect(result.reply).toContain('plugins');
    expect(result.reply).toContain('connect');
    expect(result.reply).toContain('forget');
    expect(result.reply).toContain('status');
  });

  // ── Budget expanded ────────────────────────────────────────────────────

  it('/alduin budget set daily updates limit and audits', () => {
    const result = handleAdminCommand('/alduin budget set daily 25.00', makeCtx(), deps);
    expect(result.reply).toContain('$25.00');
    expect(deps.budgetTracker.setDailyLimit).toHaveBeenCalledWith(25);
    expect(deps.auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'budget.set.daily' }),
    );
  });

  it('/alduin budget set warn updates threshold and audits', () => {
    const result = handleAdminCommand('/alduin budget set warn 0.9', makeCtx(), deps);
    expect(result.reply).toContain('90%');
    expect(deps.budgetTracker.setWarningThreshold).toHaveBeenCalledWith(0.9);
    expect(deps.auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'budget.set.warn' }),
    );
  });

  it('/alduin budget set warn rejects invalid threshold', () => {
    const r1 = handleAdminCommand('/alduin budget set warn 1.5', makeCtx(), deps);
    expect(r1.reply).toContain('Usage');
    const r2 = handleAdminCommand('/alduin budget set warn -0.1', makeCtx(), deps);
    expect(r2.reply).toContain('Usage');
  });

  it('/alduin budget set per_model sets limit and audits', () => {
    const result = handleAdminCommand('/alduin budget set per_model openai/gpt-4.1 3.50', makeCtx(), deps);
    expect(result.reply).toContain('openai/gpt-4.1');
    expect(result.reply).toContain('$3.50');
    expect(deps.budgetTracker.setPerModelLimit).toHaveBeenCalledWith('openai/gpt-4.1', 3.5);
    expect(deps.auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'budget.set.per_model.openai/gpt-4.1' }),
    );
  });

  it('/alduin budget set user:alice 5 still works (legacy)', () => {
    const result = handleAdminCommand('/alduin budget set user:alice 5', makeCtx(), deps);
    expect(result.reply).toContain('$5.00');
    expect(deps.scopedBudget!.setScopedLimit).toHaveBeenCalledWith('user', 'alice', 5);
  });

  // ── Policy expanded ────────────────────────────────────────────────────

  it('/alduin policy allow skill adds rule and audits', () => {
    const result = handleAdminCommand('/alduin policy allow skill research', makeCtx(), deps);
    expect(result.reply).toContain('research');
    expect(result.reply).toContain('allowed');
    expect(deps.policyEngine.addRule).toHaveBeenCalledWith(
      expect.objectContaining({ allowed_skills: ['research', '*'] }),
    );
    expect(deps.auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'policy.allow.skill' }),
    );
  });

  it('/alduin policy deny connector adds rule and audits', () => {
    const result = handleAdminCommand('/alduin policy deny connector google-cal', makeCtx(), deps);
    expect(result.reply).toContain('google-cal');
    expect(result.reply).toContain('denied');
    expect(deps.policyEngine.addRule).toHaveBeenCalledWith(
      expect.objectContaining({ allowed_connectors: [] }),
    );
    expect(deps.auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'policy.deny.connector' }),
    );
  });

  it('/alduin policy allow tool adds rule and audits', () => {
    const result = handleAdminCommand('/alduin policy allow tool echo', makeCtx(), deps);
    expect(result.reply).toContain('echo');
    expect(deps.policyEngine.addRule).toHaveBeenCalledWith(
      expect.objectContaining({ allowed_tools: ['echo', '*'] }),
    );
    expect(deps.auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'policy.allow.tool' }),
    );
  });

  it('/alduin policy allow (legacy bare action) still works', () => {
    const result = handleAdminCommand('/alduin policy allow write', makeCtx(), deps);
    expect(result.reply).toContain('write');
    expect(result.reply).toContain('allowed');
    expect(deps.policyEngine.addRule).toHaveBeenCalledWith(
      expect.objectContaining({ allowed_executors: ['write', '*'] }),
    );
  });

  it('/alduin policy deny without target shows usage', () => {
    const result = handleAdminCommand('/alduin policy deny', makeCtx(), deps);
    expect(result.reply).toContain('Usage');
  });

  // ── Models ─────────────────────────────────────────────────────────────

  it('/alduin models list shows catalog', () => {
    deps.catalog = {
      listModels: () => ['anthropic/claude-sonnet-4-6', 'openai/gpt-4.1'],
      isDeprecated: () => false,
    } as any;

    const result = handleAdminCommand('/alduin models list', makeCtx(), deps);
    expect(result.reply).toContain('Models (2)');
    expect(result.reply).toContain('anthropic/claude-sonnet-4-6');
    expect(result.reply).toContain('openai/gpt-4.1');
  });

  it('/alduin models list marks deprecated models', () => {
    deps.catalog = {
      listModels: () => ['old/model'],
      isDeprecated: () => true,
    } as any;

    const result = handleAdminCommand('/alduin models list', makeCtx(), deps);
    expect(result.reply).toContain('(deprecated)');
  });

  it('/alduin models list says not available without catalog', () => {
    const result = handleAdminCommand('/alduin models list', makeCtx(), deps);
    expect(result.reply).toContain('not available');
  });

  it('/alduin models sync delegates to CLI and audits', () => {
    const result = handleAdminCommand('/alduin models sync', makeCtx(), deps);
    expect(result.reply).toContain('terminal');
    expect(deps.auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'models.sync' }),
    );
  });

  it('/alduin models upgrade delegates to CLI and audits', () => {
    const result = handleAdminCommand('/alduin models upgrade', makeCtx(), deps);
    expect(result.reply).toContain('terminal');
    expect(deps.auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'models.upgrade' }),
    );
  });

  // ── Plugins ────────────────────────────────────────────────────────────

  it('/alduin plugins list shows registered plugins', () => {
    deps.pluginRegistry = {
      listPlugins: () => ['tool-echo', 'anthropic'],
      getPluginEntry: (id: string) => ({
        manifest: { id, kind: id === 'tool-echo' ? 'tool' : 'provider', version: '0.1.0' },
        source: 'builtin',
      }),
    } as any;

    const result = handleAdminCommand('/alduin plugins list', makeCtx(), deps);
    expect(result.reply).toContain('Plugins (2)');
    expect(result.reply).toContain('tool-echo');
    expect(result.reply).toContain('tool v0.1.0');
    expect(result.reply).toContain('anthropic');
  });

  it('/alduin plugins list says not available without registry', () => {
    const result = handleAdminCommand('/alduin plugins list', makeCtx(), deps);
    expect(result.reply).toContain('not available');
  });

  it('/alduin plugins install audits and shows CLI instruction', () => {
    const result = handleAdminCommand('/alduin plugins install my-tool', makeCtx(), deps);
    expect(result.reply).toContain('npm install');
    expect(deps.auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'plugins.install', new_value: 'my-tool' }),
    );
  });

  it('/alduin plugins remove audits and shows CLI instruction', () => {
    const result = handleAdminCommand('/alduin plugins remove old-tool', makeCtx(), deps);
    expect(result.reply).toContain('npm uninstall');
    expect(deps.auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'plugins.remove', new_value: 'old-tool' }),
    );
  });

  it('/alduin plugins install without id shows usage', () => {
    const result = handleAdminCommand('/alduin plugins install', makeCtx(), deps);
    expect(result.reply).toContain('Usage');
  });
});
