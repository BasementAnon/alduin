import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleAdminCommand } from './admin.js';
import type { AdminCommandContext, AdminDeps } from './admin.js';
import { PolicyEngine } from '../../auth/policy.js';
import { AuditLog } from '../../auth/audit.js';
import { BudgetTracker } from '../../tokens/budget.js';
import { TraceLogger } from '../../trace/logger.js';
import { HotMemory } from '../../memory/hot.js';
import { WarmMemory } from '../../memory/warm.js';
import { ColdMemory } from '../../memory/cold.js';
import { ContextReferenceDetector } from '../../memory/detector.js';
import { MemoryManager } from '../../memory/manager.js';
import { ProviderRegistry } from '../../providers/registry.js';
import { TokenCounter } from '../../tokens/counter.js';
import Database from 'better-sqlite3';
import { RoleResolver } from '../../auth/roles.js';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AlduinConfig } from '../../config/types.js';

const config: AlduinConfig = {
  orchestrator: {
    model: 'anthropic/claude-sonnet-4-6',
    max_planning_tokens: 4000,
    context_strategy: 'sliding_window',
    context_window: 16000,
  },
  executors: {},
  providers: {},
  routing: { pre_classifier: false, classifier_model: 'classifier', complexity_threshold: 0.6 },
  budgets: { daily_limit_usd: 10, per_task_limit_usd: 2, warning_threshold: 0.8 },
  memory: { hot_turns: 3, warm_max_tokens: 500, cold_enabled: true, cold_similarity_threshold: 0.7 },
};

function makeCtx(role: 'owner' | 'admin' | 'member' = 'owner'): AdminCommandContext {
  return {
    tenant_id: 'acme',
    user_id: 'user-1',
    user_role: role,
    session_id: 'sess-1',
    is_group: false,
  };
}

describe('/alduin forget', () => {
  let tmpDir: string;
  let deps: AdminDeps;
  let memoryManager: MemoryManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'alduin-forget-'));
    const db = new Database(':memory:');
    const roleResolver = RoleResolver.create(db);
    const policyEngine = new PolicyEngine();
    const auditLog = new AuditLog(join(tmpDir, 'audit.log'), 'test-hmac-key');
    const budgetTracker = new BudgetTracker(config.budgets);
    const traceLogger = new TraceLogger();
    const registry = new ProviderRegistry();
    const tokenCounter = new TokenCounter();

    const hot = new HotMemory(3);
    const warm = new WarmMemory(registry, config, tokenCounter);
    const cold = new ColdMemory(registry, config);
    const detector = new ContextReferenceDetector();
    memoryManager = new MemoryManager(hot, warm, cold, detector, config, tokenCounter);

    deps = {
      roleResolver,
      policyEngine,
      auditLog,
      budgetTracker,
      traceLogger,
      startedAt: new Date(),
      activeSessionCount: () => 1,
      memoryManager,
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('wipes all memory tiers and returns confirmation', async () => {
    // Add some turns to each tier
    await memoryManager.addTurn({ role: 'user', content: 'Turn 1', timestamp: new Date() });
    await memoryManager.addTurn({ role: 'assistant', content: 'Reply 1', timestamp: new Date() });

    expect(memoryManager.getStats().hot_turns).toBeGreaterThan(0);

    const result = handleAdminCommand('/alduin forget', makeCtx(), deps);

    expect(result.handled).toBe(true);
    expect(result.reply).toContain('cleared');

    const stats = memoryManager.getStats();
    expect(stats.hot_turns).toBe(0);
    expect(stats.warm_tokens).toBe(0);
    expect(stats.cold_entries).toBe(0);
  });

  it('logs the forget action to the audit log', () => {
    handleAdminCommand('/alduin forget', makeCtx(), deps);

    const auditContent = readFileSync(join(tmpDir, 'audit.log'), 'utf-8');
    expect(auditContent).toContain('memory.forget');
    expect(auditContent).toContain('user-1');
  });

  it('denies member role', () => {
    const result = handleAdminCommand('/alduin forget', makeCtx('member'), deps);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('owner or admin');
    // Memory should NOT be wiped
    expect(memoryManager.getStats().hot_turns).toBe(0); // was already empty — no change
  });

  it('handles missing memoryManager gracefully', () => {
    const depsWithout = { ...deps, memoryManager: undefined };
    const result = handleAdminCommand('/alduin forget', makeCtx(), depsWithout);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('not available');
  });
});

describe('Memory redaction on promotion', () => {
  it('redacts secrets in turns promoted to warm memory', async () => {
    const registry = new ProviderRegistry();
    const tokenCounter = new TokenCounter();
    const hot = new HotMemory(1); // evict immediately on 2nd turn
    const warm = new WarmMemory(registry, config, tokenCounter);
    const cold = new ColdMemory(registry, config);
    const detector = new ContextReferenceDetector();
    const mgr = new MemoryManager(hot, warm, cold, detector, config, tokenCounter);

    // First turn goes into hot
    await mgr.addTurn({
      role: 'user',
      content: 'My key is sk-abcdefghijklmnopqrstuvwxyz1234',
      timestamp: new Date(),
    });

    // Second turn evicts the first to warm
    await mgr.addTurn({ role: 'assistant', content: 'Got it', timestamp: new Date() });

    // The warm summary should not contain the raw secret
    const summary = warm.getSummary();
    expect(summary).not.toContain('sk-abcdefghijklmnopqrstuvwxyz1234');
    expect(summary).toContain('[REDACTED_OPENAI]');
  });
});
