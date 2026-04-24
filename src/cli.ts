#!/usr/bin/env node

/**
 * Alduin CLI — interactive orchestrator REPL.
 * Wires together all Phase 1–5 modules into a single interactive session.
 */

import readline from 'node:readline';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';

import { loadConfig } from './config/loader.js';
import { loadCatalog } from './catalog/catalog.js';
import { ProviderRegistry } from './providers/registry.js';
import { PolicyEngine, DEFAULT_POLICY_VERDICT } from './auth/policy.js';
import type { PolicyVerdict } from './auth/policy.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { OllamaProvider } from './providers/ollama.js';
import { OpenAICompatibleProvider } from './providers/openai-compatible.js';
import { TokenCounter } from './tokens/counter.js';
import type { ModelCatalog } from './catalog/catalog.js';
import { BudgetTracker, BudgetGuard } from './tokens/budget.js';
import { ResultSummarizer } from './executor/summarizer.js';
import { ExecutorDispatcher } from './executor/dispatch.js';
import { TraceLogger } from './trace/logger.js';
import { OrchestratorLoop } from './orchestrator/loop.js';
import { MessageClassifier } from './router/classifier.js';
import { Router } from './router/router.js';
import { HotMemory } from './memory/hot.js';
import { WarmMemory } from './memory/warm.js';
import { ColdMemory } from './memory/cold.js';
import { ContextReferenceDetector } from './memory/detector.js';
import { MemoryManager } from './memory/manager.js';
import { SkillRegistry } from './skills/registry.js';
import { CircuitBreaker } from './resilience/circuit-breaker.js';
import { FallbackChain } from './resilience/fallback.js';
import { UsageReporter } from './dashboard/reporter.js';
import { CliDashboard } from './dashboard/cli-ui.js';
import type { ConversationTurn } from './types/llm.js';
import type { AlduinConfig } from './config/types.js';

const BUDGET_STATE_FILE = '.budget-state.json';
const SKILLS_DIR = './skills';
const VERSION = '0.1.0';

// ──────────────────────────────────────────────────────────────────────────────
// Provider initialization
// ──────────────────────────────────────────────────────────────────────────────

function providerTimeoutMs(providerName: string, config: AlduinConfig): number {
  const DEFAULT = 60_000;
  let min = DEFAULT;
  for (const executor of Object.values(config.executors)) {
    if (executor.model.startsWith(`${providerName}/`) && executor.request_timeout_ms) {
      min = Math.min(min, executor.request_timeout_ms);
    }
  }
  return min;
}

function initProviders(
  config: AlduinConfig,
  registry: ProviderRegistry,
  catalog: ModelCatalog | undefined
): string[] {
  const loaded: string[] = [];

  for (const [name, providerConfig] of Object.entries(config.providers)) {
    try {
      const apiKey = providerConfig.api_key_env
        ? process.env[providerConfig.api_key_env] ?? ''
        : '';

      if (providerConfig.api_key_env && !apiKey) {
        console.warn(
          `[Alduin] Warning: ${providerConfig.api_key_env} not set — skipping provider "${name}"`
        );
        continue;
      }

      const timeoutMs = providerTimeoutMs(name, config);

      if (providerConfig.api_type === 'openai-compatible' && providerConfig.base_url) {
        const provider = new OpenAICompatibleProvider(providerConfig.base_url, apiKey, catalog, timeoutMs);
        registry.register(name, provider);
      } else if (providerConfig.base_url && !providerConfig.api_key_env) {
        const provider = new OllamaProvider(providerConfig.base_url, catalog);
        registry.register(name, provider);
      } else if (name === 'anthropic' || name.includes('anthropic')) {
        const provider = new AnthropicProvider(apiKey, catalog, timeoutMs);
        registry.register(name, provider);
      } else if (name === 'openai' || name.includes('openai')) {
        const provider = new OpenAIProvider(apiKey, catalog, timeoutMs);
        registry.register(name, provider);
      } else if (providerConfig.base_url) {
        const provider = new OllamaProvider(providerConfig.base_url, catalog);
        registry.register(name, provider);
      }

      loaded.push(name);
    } catch (e) {
      console.warn(`[Alduin] Failed to init provider "${name}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return loaded;
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Parse args
  let configPath = './config.yaml';
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        config: { type: 'string', short: 'c' },
        'dry-run': { type: 'boolean' },
        model: { type: 'string' },
      },
      strict: false,
    });
    if (typeof values.config === 'string') configPath = values.config;
  } catch {
    // parseArgs not critical
  }

  const positionalArgs = process.argv.slice(2).filter((a) => !a.startsWith('-'));

  // ── npm script shortcuts ────────────────────────────────────────────────────
  // Allow `alduin build`, `alduin test`, etc. to delegate to the corresponding
  // npm script so users never need to type `npm run` directly.
  const NPM_SCRIPTS = new Set([
    'build', 'build:sdk', 'dev', 'dev:telegram',
    'test', 'test:watch', 'test:coverage',
    'lint', 'clean', 'config:generate', 'config:check',
  ]);

  if (positionalArgs[0] && NPM_SCRIPTS.has(positionalArgs[0])) {
    const script = positionalArgs[0];
    const extra = process.argv.slice(3); // everything after the script name
    const cmd = extra.length > 0
      ? `npm run ${script} -- ${extra.join(' ')}`
      : `npm run ${script}`;
    try {
      execSync(cmd, { stdio: 'inherit', cwd: process.env.ALDUIN_PROJECT_ROOT ?? process.cwd() });
    } catch {
      process.exit(1);
    }
    return;
  }

  // Handle `init` subcommand
  if (positionalArgs[0] === 'init') {
    const { runInitWizard } = await import('./cli/wizard/index.js');
    await runInitWizard();
    return;
  }

  // Handle `config` subcommand
  if (positionalArgs[0] === 'config') {
    const { handleConfigCommand } = await import('./cli/config.js');
    handleConfigCommand(positionalArgs.slice(1), configPath);
    return;
  }

  // Handle `doctor` subcommand
  if (positionalArgs[0] === 'doctor') {
    const { handleDoctorCommand } = await import('./cli/doctor.js');
    await handleDoctorCommand({
      configPath,
      fix: process.argv.includes('--fix'),
    });
    return;
  }

  // Handle `skills` subcommand
  if (positionalArgs[0] === 'skills') {
    const { handleSkillsCommand } = await import('./cli/skills.js');
    handleSkillsCommand(positionalArgs.slice(1));
    return;
  }

  // Handle `admin` subcommand (e.g. `alduin admin bootstrap --tenant ... --user-id ...`)
  if (positionalArgs[0] === 'admin') {
    const { handleAdminCommand } = await import('./cli/admin.js');
    await handleAdminCommand(positionalArgs.slice(1), configPath);
    return;
  }

  // Handle `models` subcommand before starting REPL
  if (positionalArgs[0] === 'models' && positionalArgs[1]) {
    const { handleModelsCommand } = await import('./cli/models.js');
    const flags: { dryRun?: boolean; model?: string } = {};
    if (process.argv.includes('--dry-run')) flags.dryRun = true;
    const modelIdx = process.argv.indexOf('--model');
    if (modelIdx !== -1 && process.argv[modelIdx + 1]) flags.model = process.argv[modelIdx + 1];
    await handleModelsCommand(positionalArgs[1], configPath, flags);
    return;
  }

  // Load config
  const configResult = loadConfig(configPath);
  if (!configResult.ok) {
    console.error(`[Alduin] Config error: ${configResult.error.message}`);
    process.exit(1);
  }
  const config = configResult.value;

  // Load model catalog
  const catalogResult = loadCatalog();
  let catalog: ModelCatalog | undefined;
  if (catalogResult.ok) {
    catalog = catalogResult.value;
    if (config.catalog_version && config.catalog_version !== catalog.version) {
      console.warn(
        `[Alduin] Warning: config catalog_version "${config.catalog_version}" ` +
        `does not match loaded catalog "${catalog.version}". Run \`alduin models sync\`.`
      );
    }
  } else {
    console.warn(`[Alduin] Warning: ${catalogResult.error.message}. Pricing/tokenizer data may be incomplete.`);
  }

  // Initialize providers (catalog injected for pricing/tokenizer)
  const registry = new ProviderRegistry();
  const loadedProviders = initProviders(config, registry, catalog);

  // Core services
  const tokenCounter = new TokenCounter(catalog);

  // Budget tracker — try to restore from disk
  let budgetTracker: BudgetTracker;
  if (existsSync(BUDGET_STATE_FILE)) {
    try {
      budgetTracker = BudgetTracker.restore(BUDGET_STATE_FILE, config.budgets);
    } catch {
      budgetTracker = new BudgetTracker(config.budgets);
    }
  } else {
    budgetTracker = new BudgetTracker(config.budgets);
  }
  const budgetGuard = new BudgetGuard(budgetTracker);

  // Classifier executor name → model for summarizer
  const classifierExecutor = config.executors[config.routing.classifier_model];
  const summarizerModel = classifierExecutor?.model ?? config.orchestrator.model;
  const summarizer = new ResultSummarizer(registry, {
    model: summarizerModel,
    max_tokens: 300,
  });

  const dispatcher = new ExecutorDispatcher(
    registry, config, budgetGuard, summarizer, tokenCounter
  );
  const traceLogger = new TraceLogger();
  const orchestratorLoop = new OrchestratorLoop(
    config, registry, dispatcher, budgetGuard, tokenCounter, traceLogger
  );
  const classifier = new MessageClassifier(registry, config, tokenCounter);

  // Memory tiers
  const hotMemory = new HotMemory(config.memory?.hot_turns ?? 3);
  const warmMemory = new WarmMemory(registry, config, tokenCounter);
  const coldMemory = new ColdMemory(registry, config);
  const detector = new ContextReferenceDetector();
  const memoryManager = new MemoryManager(
    hotMemory, warmMemory, coldMemory, detector, config, tokenCounter
  );

  // Skills
  const skillRegistry = new SkillRegistry(SKILLS_DIR);
  try {
    skillRegistry.loadManifest();
  } catch {
    // Skills are optional
  }

  // Resilience
  const circuitBreakers = new Map<string, CircuitBreaker>();
  const fallbackChain = new FallbackChain(
    registry,
    config.fallbacks ?? {},
    circuitBreakers
  );
  void fallbackChain; // available for future use

  // Policy engine (CLI always uses default permissive verdict)
  const policyEngine = new PolicyEngine();

  // Router
  const router = new Router(
    config, classifier, orchestratorLoop, dispatcher, traceLogger, tokenCounter
  );

  // Dashboard
  const reporter = new UsageReporter(budgetTracker, traceLogger);
  const dashboard = new CliDashboard(reporter);

  // Print banner
  const budgetSummary = budgetTracker.getDailySummary();
  const modelsLine = loadedProviders.length > 0
    ? loadedProviders.join(', ')
    : 'none (check API keys in .env)';

  console.log(`
╦ ╦┌─┐┬  ┬┌─┐┌─┐
╠═╣├┤ │  ││ │└─┐
╩ ╩└─┘┴─┘┴└─┘└─┘  v${VERSION}

Models: ${modelsLine}
Budget: $${budgetSummary.budget_remaining.toFixed(2)} / $${config.budgets.daily_limit_usd.toFixed(2)} daily
Type /help for commands, or start chatting.
`);

  // Session state
  const conversationHistory: ConversationTurn[] = [];
  let sessionCost = 0;
  let taskCount = 0;

  // Prune completed traces older than 1 hour every 50 tasks to prevent memory leak
  const TRACE_MAX_AGE_MS = 60 * 60 * 1000;
  const TRACE_PRUNE_INTERVAL = 50;

  // REPL
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'you> ',
  });

  const handleExit = async (): Promise<void> => {
    console.log('\nEnding session…');
    await memoryManager.endSession();
    try { budgetTracker.persist(BUDGET_STATE_FILE); } catch { /* best effort */ }
    console.log(
      `Session total: $${sessionCost.toFixed(4)} across ${taskCount} tasks. Goodbye.`
    );
    process.exit(0);
  };

  process.on('SIGINT', () => { void handleExit(); });

  rl.on('close', () => { void handleExit(); });

  rl.prompt();

  rl.on('line', async (input) => {
    const line = input.trim();
    if (!line) { rl.prompt(); return; }

    // ── Slash commands ────────────────────────────────────────────────────────
    if (line.startsWith('/')) {
      const [cmd, ...args] = line.split(' ');

      switch (cmd) {
        case '/help':
          console.log(`
Commands:
  /status          Memory stats + session cost
  /usage           Daily cost report
  /trace <id>      Show task trace
  /budget          Budget status
  /models          List configured models
  /new             Start a new session (clears memory)
  /quit /exit      Exit Alduin
`);
          break;

        case '/status': {
          const stats = memoryManager.getStats();
          console.log(dashboard.renderStatus({ ...stats, session_cost: sessionCost }));
          break;
        }

        case '/usage':
          console.log(dashboard.renderDailySummary());
          break;

        case '/trace': {
          const taskId = args[0];
          if (!taskId) { console.log('Usage: /trace <task_id>'); break; }
          console.log(dashboard.renderTaskTrace(taskId));
          break;
        }

        case '/budget': {
          const s = budgetTracker.getDailySummary();
          const pct = ((s.total_cost / config.budgets.daily_limit_usd) * 100).toFixed(1);
          console.log(`Budget: $${s.total_cost.toFixed(4)} used / $${s.budget_remaining.toFixed(2)} remaining (${pct}%)`);
          if (s.per_model.size > 0) {
            console.log('Per model:');
            for (const [model, usage] of s.per_model) {
              console.log(`  ${model}: $${usage.cost.toFixed(4)}`);
            }
          }
          break;
        }

        case '/models': {
          const providers = registry.listProviders();
          if (providers.length === 0) {
            console.log('No providers loaded.');
          } else {
            console.log('Loaded providers:');
            for (const p of providers) {
              const fallbacks = config.fallbacks
                ? Object.entries(config.fallbacks)
                    .filter(([, chain]) => chain.includes(p))
                    .map(([primary]) => primary)
                : [];
              const fallbackNote = fallbacks.length > 0 ? ` (fallback for: ${fallbacks.join(', ')})` : '';
              console.log(`  ${p}${fallbackNote}`);
            }
          }
          break;
        }

        case '/new':
          await memoryManager.endSession();
          conversationHistory.length = 0;
          sessionCost = 0;
          taskCount = 0;
          console.log('New session started.');
          break;

        case '/quit':
        case '/exit':
          await handleExit();
          return;

        default:
          console.log(`Unknown command: ${cmd}. Type /help for available commands.`);
      }

      rl.prompt();
      return;
    }

    // ── User message ──────────────────────────────────────────────────────────
    const userTurn: ConversationTurn = {
      role: 'user',
      content: line,
      timestamp: new Date(),
    };
    conversationHistory.push(userTurn);
    await memoryManager.addTurn(userTurn);

    try {
      // CLI always uses default permissive verdict for interactive sessions
      const verdict: PolicyVerdict = DEFAULT_POLICY_VERDICT;
      const { response, trace } = await router.route(line, conversationHistory, verdict);

      // Print response
      console.log(`\nalduin> ${response}\n`);

      // Inline cost info
      const cost = trace.total_cost_usd;
      const tokens = trace.total_tokens.input + trace.total_tokens.output;
      const latency = (trace.total_latency_ms / 1000).toFixed(1);
      console.log(`  ($${cost.toFixed(4)} | ${tokens.toLocaleString()} tokens | ${latency}s)`);

      // Accumulate session stats
      sessionCost += cost;
      taskCount++;

      // Periodically prune old traces to bound memory usage
      if (taskCount % TRACE_PRUNE_INTERVAL === 0) {
        traceLogger.pruneOlderThan(TRACE_MAX_AGE_MS);
      }

      // Budget warning
      const budgetCheck = budgetTracker.checkBudget(config.orchestrator.model);
      if (budgetCheck.warning) {
        const pct = ((1 - budgetCheck.remaining_usd / config.budgets.daily_limit_usd) * 100).toFixed(1);
        console.log(`  ⚠ Budget warning: ${pct}% of daily limit used`);
      }

      // Record assistant turn in history and memory
      const assistantTurn: ConversationTurn = {
        role: 'assistant',
        content: response,
        timestamp: new Date(),
      };
      conversationHistory.push(assistantTurn);
      await memoryManager.addTurn(assistantTurn);
    } catch (e) {
      console.log(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }

    rl.prompt();
  });
}

main().catch((e: unknown) => {
  console.error('Fatal:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
