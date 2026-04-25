import type { UserRole } from '../../auth/roles.js';
import type { RoleResolver } from '../../auth/roles.js';
import type { PolicyEngine } from '../../auth/policy.js';
import type { AuditLog } from '../../auth/audit.js';
import type { BudgetTracker } from '../../tokens/budget.js';
import type { ScopedBudgetTracker } from '../../tokens/budget.js';
import type { TraceLogger } from '../../trace/logger.js';
import type { MemoryManager } from '../../memory/manager.js';
import type { SessionStore } from '../../session/store.js';
import type { ModelCatalog } from '../../catalog/catalog.js';
import type { PluginRegistry } from '../../plugins/registry.js';
import { validatePluginId } from '../../plugins/validate-id.js';

export interface AdminCommandContext {
  tenant_id: string;
  user_id: string;
  user_role: UserRole;
  session_id: string;
  is_group: boolean;
  group_id?: string;
}

export interface AdminCommandResult {
  handled: boolean;
  reply?: string;
}

export interface AdminDeps {
  roleResolver: RoleResolver;
  policyEngine: PolicyEngine;
  auditLog: AuditLog;
  budgetTracker: BudgetTracker;
  scopedBudget?: ScopedBudgetTracker;
  traceLogger: TraceLogger;
  startedAt: Date;
  activeSessionCount: () => number;
  /** Optional: the session's memory manager for /alduin forget */
  memoryManager?: MemoryManager;
  /** Optional: session store for persisting session-scoped overrides */
  sessionStore?: SessionStore;
  /** Optional: model catalog for /alduin models list */
  catalog?: ModelCatalog;
  /** Optional: plugin registry for /alduin plugins list */
  pluginRegistry?: PluginRegistry;
  /**
   * Optional: restart the Telegram connection. Called by /alduin telegram restart.
   * Returns a promise resolving to { botUsername } on success.
   */
  restartTelegram?: () => Promise<{ botUsername: string }>;
}

/**
 * Handle /alduin admin commands.
 * Requires owner or admin role — all others get a denial message.
 */
export function handleAdminCommand(
  text: string,
  ctx: AdminCommandContext,
  deps: AdminDeps
): AdminCommandResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/alduin')) {
    return { handled: false };
  }

  // Role gate
  if (ctx.user_role !== 'owner' && ctx.user_role !== 'admin') {
    return {
      handled: true,
      reply: 'Denied: admin commands require owner or admin role.',
    };
  }

  const parts = trimmed.split(/\s+/);
  const subcommand = parts[1]; // parts[0] is "/alduin"

  switch (subcommand) {
    case 'budget':
      return handleBudget(parts.slice(2), ctx, deps);

    case 'policy':
      return handlePolicy(parts.slice(2), ctx, deps);

    case 'trace':
      return handleTrace(parts.slice(2), deps);

    case 'recursion':
      return handleRecursion(parts.slice(2), ctx, deps);

    case 'telegram':
      return handleTelegram(parts.slice(2), ctx, deps);

    case 'models':
      return handleModels(parts.slice(2), ctx, deps);

    case 'plugins':
      return handlePlugins(parts.slice(2), ctx, deps);

    case 'forget':
      return handleForget(ctx, deps);

    case 'connect':
      return {
        handled: true,
        reply: `Use /connect ${parts[2] ?? '<connector_id>'} to link a service.`,
      };

    case 'status':
      return handleStatus(ctx, deps);

    default:
      return {
        handled: true,
        reply: [
          'Admin commands:',
          '  /alduin budget [show|set daily <usd>|set warn <0-1>|set per_model <model> <usd>]',
          '  /alduin policy [show|allow|deny <skill|connector|tool> <name>]',
          '  /alduin trace <id|last>',
          '  /alduin recursion [on|off|status]',
          '  /alduin telegram restart — restart Telegram long-poll connection',
          '  /alduin models [list|sync|diff|upgrade]',
          '  /alduin plugins [list|install <id>|remove <id>]',
          '  /alduin connect <connector_id>',
          '  /alduin forget — wipe all memory (hot, warm, cold) for this session',
          '  /alduin status',
        ].join('\n'),
      };
  }
}

// ── telegram subcommand ───────────────────────────────────────────────────────

function handleTelegram(
  args: string[],
  ctx: AdminCommandContext,
  deps: AdminDeps
): AdminCommandResult {
  const action = args[0];

  if (action !== 'restart') {
    return {
      handled: true,
      reply: 'Usage: /alduin telegram restart',
    };
  }

  if (!deps.restartTelegram) {
    return {
      handled: true,
      reply: 'Telegram restart is not available in this session (no restartTelegram handler configured).',
    };
  }

  // Kick off the async restart and return an immediate acknowledgement.
  // The bot will log the result when the restart completes.
  void deps.restartTelegram().then(({ botUsername }) => {
    console.log(`[Telegram] Restarted as @${botUsername} (triggered by admin command)`);
  }).catch((err: unknown) => {
    console.error(`[Telegram] Restart failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  deps.auditLog.log({
    actor: ctx.user_id,
    action: 'telegram.restart',
    new_value: 'triggered via admin command',
  });

  return {
    handled: true,
    reply: 'Restarting Telegram connection... (long-poll mode)',
  };
}

// ── forget subcommand ─────────────────────────────────────────────────────────

function handleForget(
  ctx: AdminCommandContext,
  deps: AdminDeps
): AdminCommandResult {
  if (!deps.memoryManager) {
    return { handled: true, reply: 'Memory manager not available.' };
  }

  deps.memoryManager.forget();

  deps.auditLog.log({
    actor: ctx.user_id,
    action: 'memory.forget',
    new_value: `session=${ctx.session_id}`,
  });

  return {
    handled: true,
    reply: '🗑️ Memory cleared. Hot, warm, and cold memory for this session have been wiped.',
  };
}

// ── budget subcommand ─────────────────────────────────────────────────────────

function handleBudget(
  args: string[],
  ctx: AdminCommandContext,
  deps: AdminDeps
): AdminCommandResult {
  const action = args[0] ?? 'show';

  if (action === 'show') {
    const summary = deps.budgetTracker.getDailySummary();
    const lines = [`Global budget: $${summary.total_cost.toFixed(4)} / $${summary.budget_remaining.toFixed(2)} remaining`];

    if (deps.scopedBudget) {
      if (ctx.is_group && ctx.group_id) {
        const groupSpent = deps.scopedBudget.getScopedSpend('group', ctx.group_id);
        lines.push(`Group budget: $${groupSpent.toFixed(4)}`);
      }
      const userSpent = deps.scopedBudget.getScopedSpend('user', ctx.user_id);
      lines.push(`User budget: $${userSpent.toFixed(4)}`);
    }

    for (const [model, usage] of summary.per_model) {
      lines.push(`  ${model}: $${usage.cost.toFixed(4)}`);
    }
    return { handled: true, reply: lines.join('\n') };
  }

  if (action === 'set') {
    const subAction = args[1]; // daily, warn, per_model, or user:/group: scope

    // /alduin budget set daily <usd>
    if (subAction === 'daily') {
      const usd = parseFloat(args[2] ?? '');
      if (!Number.isFinite(usd) || usd <= 0) {
        return { handled: true, reply: 'Usage: /alduin budget set daily <usd>' };
      }
      deps.budgetTracker.setDailyLimit(usd);
      deps.auditLog.log({
        actor: ctx.user_id,
        action: 'budget.set.daily',
        new_value: `$${usd.toFixed(2)}`,
      });
      return { handled: true, reply: `Daily budget set to $${usd.toFixed(2)}.` };
    }

    // /alduin budget set warn <threshold 0-1>
    if (subAction === 'warn') {
      const threshold = parseFloat(args[2] ?? '');
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        return { handled: true, reply: 'Usage: /alduin budget set warn <0.0-1.0>' };
      }
      deps.budgetTracker.setWarningThreshold(threshold);
      deps.auditLog.log({
        actor: ctx.user_id,
        action: 'budget.set.warn',
        new_value: `${(threshold * 100).toFixed(0)}%`,
      });
      return { handled: true, reply: `Warning threshold set to ${(threshold * 100).toFixed(0)}%.` };
    }

    // /alduin budget set per_model <model> <usd>
    if (subAction === 'per_model') {
      const model = args[2];
      const usd = parseFloat(args[3] ?? '');
      if (!model || !Number.isFinite(usd) || usd <= 0) {
        return { handled: true, reply: 'Usage: /alduin budget set per_model <model> <usd>' };
      }
      deps.budgetTracker.setPerModelLimit(model, usd);
      deps.auditLog.log({
        actor: ctx.user_id,
        action: `budget.set.per_model.${model}`,
        new_value: `$${usd.toFixed(2)}`,
      });
      return { handled: true, reply: `Per-model budget for ${model} set to $${usd.toFixed(2)}.` };
    }

    // Legacy: /alduin budget set <scope> <usd>
    //
    // H-12: previously a missing / unrecognized scope silently fell through,
    // writing an audit entry (and reporting success to the user) while the
    // budget was never actually set. Reject anything that isn't a known
    // `user:<id>` / `group:<id>` scope with a usage hint.
    const scope = subAction;
    const usdStr = args[2];
    if (!scope || !usdStr) {
      return {
        handled: true,
        reply: 'Usage: /alduin budget set [daily|warn|per_model <model>|user:<id>|group:<id>] <value>',
      };
    }
    const usd = parseFloat(usdStr);
    if (!Number.isFinite(usd) || usd <= 0) {
      return { handled: true, reply: 'Budget must be a positive number.' };
    }

    const scopeKind: 'user' | 'group' | null = scope.startsWith('user:')
      ? 'user'
      : scope.startsWith('group:')
      ? 'group'
      : null;
    if (!scopeKind) {
      return {
        handled: true,
        reply:
          `Unknown budget scope "${scope}". ` +
          `Usage: /alduin budget set [daily|warn|per_model <model>|user:<id>|group:<id>] <value>`,
      };
    }

    const scopeId = scope.slice(scopeKind.length + 1); // drop "user:" / "group:"
    if (scopeId.length === 0) {
      return {
        handled: true,
        reply: `Scope id is required — e.g. /alduin budget set ${scopeKind}:<id> <usd>`,
      };
    }

    if (!deps.scopedBudget) {
      return {
        handled: true,
        reply: 'Scoped budgets are not available in this configuration.',
      };
    }
    deps.scopedBudget.setScopedLimit(scopeKind, scopeId, usd);

    deps.auditLog.log({
      actor: ctx.user_id,
      action: `budget.set.${scopeKind}`,
      new_value: `${scopeId}=$${usd.toFixed(2)}`,
    });

    return { handled: true, reply: `Budget for ${scope} set to $${usd.toFixed(2)}.` };
  }

  return { handled: true, reply: 'Usage: /alduin budget [show|set daily <usd>|set warn <0-1>|set per_model <model> <usd>]' };
}

// ── policy subcommand ─────────────────────────────────────────────────────────

function handlePolicy(
  args: string[],
  ctx: AdminCommandContext,
  deps: AdminDeps
): AdminCommandResult {
  const action = args[0] ?? 'show';

  if (action === 'show') {
    const rules = deps.policyEngine.getRules();
    if (rules.length === 0) {
      return { handled: true, reply: 'No custom policy rules defined. Using defaults.' };
    }
    const lines = rules.map((r, i) => {
      const scope = r.scope ?? 'all';
      const roles = r.roles?.join(',') ?? '*';
      return `${i + 1}. scope=${scope} roles=${roles} allowed=${r.allowed ?? 'inherit'}`;
    });
    return { handled: true, reply: `Policy rules:\n${lines.join('\n')}` };
  }

  if (action === 'allow' || action === 'deny') {
    const kind = args[1]; // skill, connector, tool, or bare action (legacy)
    const name = args[2];
    const allowed = action === 'allow';
    const scope = ctx.is_group ? 'group' : 'all';

    // /alduin policy allow|deny skill <name>
    if (kind === 'skill' && name) {
      deps.policyEngine.addRule({
        scope,
        allowed_skills: allowed ? [name, '*'] : [],
      });
      deps.auditLog.log({
        actor: ctx.user_id,
        action: `policy.${action}.skill`,
        new_value: name,
      });
      return { handled: true, reply: `Policy updated: skill "${name}" is now ${allowed ? 'allowed' : 'denied'}.` };
    }

    // /alduin policy allow|deny connector <name>
    if (kind === 'connector' && name) {
      deps.policyEngine.addRule({
        scope,
        allowed_connectors: allowed ? [name, '*'] : [],
      });
      deps.auditLog.log({
        actor: ctx.user_id,
        action: `policy.${action}.connector`,
        new_value: name,
      });
      return { handled: true, reply: `Policy updated: connector "${name}" is now ${allowed ? 'allowed' : 'denied'}.` };
    }

    // /alduin policy allow|deny tool <name>
    if (kind === 'tool' && name) {
      deps.policyEngine.addRule({
        scope,
        allowed_tools: allowed ? [name, '*'] : [],
      });
      deps.auditLog.log({
        actor: ctx.user_id,
        action: `policy.${action}.tool`,
        new_value: name,
      });
      return { handled: true, reply: `Policy updated: tool "${name}" is now ${allowed ? 'allowed' : 'denied'}.` };
    }

    // Legacy: /alduin policy allow|deny <action> (treats as executor)
    if (kind && !name) {
      deps.policyEngine.addRule({
        scope,
        allowed_executors: allowed ? [kind, '*'] : [],
      });
      deps.auditLog.log({
        actor: ctx.user_id,
        action: `policy.${action}`,
        new_value: kind,
      });
      return { handled: true, reply: `Policy updated: ${kind} is now ${allowed ? 'allowed' : 'denied'}.` };
    }

    return { handled: true, reply: `Usage: /alduin policy ${action} <skill|connector|tool> <name>` };
  }

  return { handled: true, reply: 'Usage: /alduin policy [show|allow|deny <skill|connector|tool> <name>]' };
}

// ── recursion subcommand ─────────────────────────────────────────────────────

function handleRecursion(
  args: string[],
  ctx: AdminCommandContext,
  deps: AdminDeps,
): AdminCommandResult {
  const action = args[0] ?? 'status';

  if (action === 'on') {
    if (deps.sessionStore) {
      deps.sessionStore.updatePolicyOverride(ctx.session_id, { recursion_disabled: false });
    }
    deps.auditLog.log({
      actor: ctx.user_id,
      action: 'recursion.enable',
      new_value: `session=${ctx.session_id}`,
    });
    return {
      handled: true,
      reply: 'Sub-orchestration enabled for this session.',
    };
  }

  if (action === 'off') {
    if (deps.sessionStore) {
      deps.sessionStore.updatePolicyOverride(ctx.session_id, { recursion_disabled: true });
    }
    deps.auditLog.log({
      actor: ctx.user_id,
      action: 'recursion.disable',
      new_value: `session=${ctx.session_id}`,
    });
    return {
      handled: true,
      reply: 'Sub-orchestration disabled for this session. No skill or executor can spawn child orchestrators until re-enabled.',
    };
  }

  if (action === 'status') {
    let disabled = false;
    if (deps.sessionStore) {
      const session = deps.sessionStore.findById(ctx.session_id);
      disabled = session?.policy_overrides?.recursion_disabled ?? false;
    }
    return {
      handled: true,
      reply: disabled
        ? 'Sub-orchestration is OFF for this session.'
        : 'Sub-orchestration is ON (default). Skills with allow_sub_orchestration can recurse.',
    };
  }

  return { handled: true, reply: 'Usage: /alduin recursion [on|off|status]' };
}

// ── trace subcommand ──────────────────────────────────────────────────────────

function handleTrace(args: string[], deps: AdminDeps): AdminCommandResult {
  const traceId = args[0];
  if (!traceId) {
    return { handled: true, reply: 'Usage: /alduin trace <trace_id|last>' };
  }

  // Use tree-aware renderer (falls back to flat for non-recursive traces)
  const output = deps.traceLogger.formatTraceTree(traceId);
  return { handled: true, reply: output };
}

// ── status subcommand ─────────────────────────────────────────────────────────

function handleStatus(
  ctx: AdminCommandContext,
  deps: AdminDeps
): AdminCommandResult {
  const uptimeMs = Date.now() - deps.startedAt.getTime();
  const uptimeH = (uptimeMs / 3_600_000).toFixed(1);
  const summary = deps.budgetTracker.getDailySummary();
  const sessionCount = deps.activeSessionCount();

  const lines = [
    `Alduin v0.1.0`,
    `Uptime: ${uptimeH}h`,
    `Budget: $${summary.total_cost.toFixed(4)} used / $${summary.budget_remaining.toFixed(2)} remaining`,
    `Active sessions: ${sessionCount}`,
  ];

  return { handled: true, reply: lines.join('\n') };
}

// ── models subcommand ───────────────────────────────────────────────────────

function handleModels(
  args: string[],
  ctx: AdminCommandContext,
  deps: AdminDeps
): AdminCommandResult {
  const action = args[0] ?? 'list';

  if (action === 'list') {
    if (!deps.catalog) {
      return { handled: true, reply: 'Model catalog not available.' };
    }
    const models = deps.catalog.listModels();
    if (models.length === 0) {
      return { handled: true, reply: 'No models in catalog.' };
    }
    const lines = models.slice(0, 20).map((m) => {
      const deprecated = deps.catalog!.isDeprecated(m);
      const status = deprecated ? ' (deprecated)' : '';
      return `  ${m}${status}`;
    });
    const more = models.length > 20 ? `\n  ... and ${models.length - 20} more` : '';
    return { handled: true, reply: `Models (${models.length}):\n${lines.join('\n')}${more}` };
  }

  // sync/diff/upgrade are complex operations — delegate to CLI
  if (action === 'sync' || action === 'diff' || action === 'upgrade') {
    deps.auditLog.log({
      actor: ctx.user_id,
      action: `models.${action}`,
      new_value: args.slice(1).join(' ') || 'default',
    });
    return {
      handled: true,
      reply: `Model ${action} is a long-running operation.\nRun in terminal: alduin models ${args.join(' ')}`,
    };
  }

  return { handled: true, reply: 'Usage: /alduin models [list|sync|diff|upgrade]' };
}

// ── plugins subcommand ──────────────────────────────────────────────────────

function handlePlugins(
  args: string[],
  ctx: AdminCommandContext,
  deps: AdminDeps
): AdminCommandResult {
  const action = args[0] ?? 'list';

  if (action === 'list') {
    if (!deps.pluginRegistry) {
      return { handled: true, reply: 'Plugin registry not available.' };
    }
    const plugins = deps.pluginRegistry.listPlugins();
    if (plugins.length === 0) {
      return { handled: true, reply: 'No plugins registered.' };
    }
    const lines = plugins.map((id) => {
      const entry = deps.pluginRegistry!.getPluginEntry(id);
      const kind = entry?.manifest.kind ?? 'unknown';
      const version = entry?.manifest.version ?? '?';
      const source = entry?.source ?? 'unknown';
      return `  ${id} (${kind} v${version}, ${source})`;
    });
    return { handled: true, reply: `Plugins (${plugins.length}):\n${lines.join('\n')}` };
  }

  if (action === 'install') {
    const rawId = args[1];
    if (!rawId) {
      return { handled: true, reply: 'Usage: /alduin plugins install <plugin_id>' };
    }
    // M-16: reject shell metacharacters and path-traversal before the
    // id ever lands in audit records or an operator-facing instruction
    // string. A future CLI runner that execFiles `npm install <id>`
    // must share the same regex — see src/plugins/validate-id.ts.
    const validation = validatePluginId(rawId);
    if (!validation.ok) {
      return {
        handled: true,
        reply: `Invalid plugin id: ${validation.error}`,
      };
    }
    const pluginId = validation.id;
    deps.auditLog.log({
      actor: ctx.user_id,
      action: 'plugins.install',
      new_value: pluginId,
    });
    return {
      handled: true,
      reply: `Plugin installation is a CLI operation.\nRun: npm install @alduin-plugin/${pluginId} && alduin doctor`,
    };
  }

  if (action === 'remove') {
    const rawId = args[1];
    if (!rawId) {
      return { handled: true, reply: 'Usage: /alduin plugins remove <plugin_id>' };
    }
    // M-16: same validation as install — never echo an unvalidated id.
    const validation = validatePluginId(rawId);
    if (!validation.ok) {
      return {
        handled: true,
        reply: `Invalid plugin id: ${validation.error}`,
      };
    }
    const pluginId = validation.id;
    deps.auditLog.log({
      actor: ctx.user_id,
      action: 'plugins.remove',
      new_value: pluginId,
    });
    return {
      handled: true,
      reply: `Plugin removal is a CLI operation.\nRun: npm uninstall @alduin-plugin/${pluginId} && alduin doctor`,
    };
  }

  return { handled: true, reply: 'Usage: /alduin plugins [list|install <id>|remove <id>]' };
}
