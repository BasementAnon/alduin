/**
 * Alduin — full two-plane runtime.
 *
 * Integration plane: gateway → session → ingestion → policy → (command router)
 * Runtime plane:     pre-classifier → orchestrator → executors → event bus → renderer
 *
 * Both planes are keyed by session_id.
 *
 * @see docs/ARCHITECTURE.md
 */

import { existsSync } from 'node:fs';

// ── Config + Catalog ──────────────────────────────────────────────────────────
import { loadConfig } from './config/loader.js';
import type { AlduinConfig } from './config/types.js';
import { loadCatalog } from './catalog/catalog.js';
import type { ModelCatalog } from './catalog/catalog.js';

// ── Integration plane ─────────────────────────────────────────────────────────
import { SessionStore } from './session/store.js';
import { SessionResolver } from './session/resolver.js';
import { WebhookGateway } from './webhooks/gateway.js';
import { TelegramAdapter } from './channels/telegram/index.js';
import { parseAndIngestUpdate } from './channels/telegram/parse.js';
import type {
  ChannelAdapter,
  RawChannelEvent,
  NormalizedEvent,
} from './channels/adapter.js';
import type { Session } from './session/types.js';
import type { Update } from 'grammy/types';

// ── Auth + Policy ─────────────────────────────────────────────────────────────
import { openSqlite } from './db/open.js';
import { RoleResolver } from './auth/roles.js';
import { PolicyEngine } from './auth/policy.js';
import type { PolicyVerdict } from './auth/policy.js';
import { AuditLog, verifyAuditLogOrThrow } from './auth/audit.js';

// ── Commands (parsed before runtime plane) ────────────────────────────────────
import { isCommand } from './channels/commands/connect.js';
import { handleConnectCommand } from './channels/commands/connect.js';
import { handleAdminCommand } from './channels/commands/admin.js';

// ── Ingestion ─────────────────────────────────────────────────────────────────
import { BlobStore } from './ingestion/blob-store.js';
import { IngestionPipeline, DEFAULT_INGESTION_CONFIG } from './ingestion/pipeline.js';
import type { ChannelDownloadConfig } from './ingestion/pipeline.js';

// ── Runtime plane ─────────────────────────────────────────────────────────────
import { ProviderRegistry, scrubSecretEnv } from './providers/registry.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { OllamaProvider } from './providers/ollama.js';
import { OpenAICompatibleProvider } from './providers/openai-compatible.js';
import { TokenCounter } from './tokens/counter.js';
import { BudgetTracker, BudgetGuard, ScopedBudgetTracker } from './tokens/budget.js';
import { ResultSummarizer } from './executor/summarizer.js';
import { ExecutorDispatcher } from './executor/dispatch.js';
import { TraceLogger } from './trace/logger.js';
import { OrchestratorLoop } from './orchestrator/loop.js';
import { MessageClassifier } from './router/classifier.js';
import { Router } from './router/router.js';

// ── Memory ────────────────────────────────────────────────────────────────────
import { HotMemory } from './memory/hot.js';
import { WarmMemory } from './memory/warm.js';
import { ColdMemory } from './memory/cold.js';
import { ContextReferenceDetector } from './memory/detector.js';
import { MemoryManager } from './memory/manager.js';

// ── Event bus + renderer ──────────────────────────────────────────────────────
import { AlduinEventBus } from './bus/event-bus.js';
import { RendererSubscriber } from './renderer/subscriber.js';
import type { PresentationPayload, ChannelTarget } from './channels/adapter.js';

// ── Types ─────────────────────────────────────────────────────────────────────
export type { NormalizedEvent, RawChannelEvent, AttachmentRef } from './channels/adapter.js';
export type { Session, PolicyOverrides } from './session/types.js';
export type { PolicyVerdict, PolicyContext } from './auth/policy.js';
export * from './types/index.js';
export * from './providers/index.js';

// ── Runtime handle ────────────────────────────────────────────────────────────

export interface AlduinRuntime {
  /** The webhook gateway (Express app) */
  gateway: WebhookGateway;
  sessionStore: SessionStore;
  /** Start the HTTP server and long-poll adapters */
  start(port?: number): Promise<void>;
  /** Graceful shutdown */
  stop(): Promise<void>;
}

const BUDGET_STATE_FILE = '.budget-state.json';
const POLICY_FILE = 'config/policy.yaml';
const AUDIT_LOG = '.alduin/audit.log';

// ── Provider initialisation ───────────────────────────────────────────────────

/**
 * Compute the effective request timeout for a provider.
 * Takes the minimum `request_timeout_ms` across all executors that use models
 * on this provider — so stricter executor configs are honoured.
 * Falls back to 60s if no executor specifies a timeout.
 */
function providerTimeoutMs(providerName: string, config: AlduinConfig): number {
  const DEFAULT = 60_000;
  let min = DEFAULT;
  for (const executor of Object.values(config.executors)) {
    // Match by provider prefix (e.g. "anthropic/" in "anthropic/claude-sonnet-4-6")
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

  for (const [name, cfg] of Object.entries(config.providers)) {
    try {
      const apiKey = cfg.api_key_env ? (process.env[cfg.api_key_env] ?? '') : '';

      if (cfg.api_key_env && !apiKey) {
        console.warn(`[Alduin] ${cfg.api_key_env} not set — skipping provider "${name}"`);
        continue;
      }

      const timeoutMs = providerTimeoutMs(name, config);

      if (cfg.api_type === 'openai-compatible' && cfg.base_url) {
        registry.register(name, new OpenAICompatibleProvider(cfg.base_url, apiKey, catalog, timeoutMs));
      } else if (cfg.base_url && !cfg.api_key_env) {
        registry.register(name, new OllamaProvider(cfg.base_url, catalog));
      } else if (name === 'anthropic' || name.includes('anthropic')) {
        registry.register(name, new AnthropicProvider(apiKey, catalog, timeoutMs));
      } else if (name === 'openai' || name.includes('openai')) {
        registry.register(name, new OpenAIProvider(apiKey, catalog, timeoutMs));
      } else if (cfg.base_url) {
        registry.register(name, new OllamaProvider(cfg.base_url, catalog));
      }

      loaded.push(name);
    } catch (e) {
      console.warn(`[Alduin] Failed to init provider "${name}": ${e instanceof Error ? e.message : e}`);
    }
  }

  scrubSecretEnv(config);
  return loaded;
}

// ── Full runtime bootstrap ────────────────────────────────────────────────────

/**
 * Create and wire the complete Alduin runtime from a config file.
 * Returns a handle to start/stop the HTTP server.
 */
export async function createRuntime(
  configPath: string,
  options: { dbPath?: string; blobsPath?: string } = {}
): Promise<AlduinRuntime> {
  const dbPath = options.dbPath ?? '.alduin-sessions.db';
  const blobsPath = options.blobsPath ?? '.alduin/blobs';

  // ── Config ────────────────────────────────────────────────────────────────
  const cfgResult = loadConfig(configPath);
  if (!cfgResult.ok) throw new Error(`Config error: ${cfgResult.error.message}`);
  const config = cfgResult.value;

  // ── Catalog ───────────────────────────────────────────────────────────────
  const catalogResult = loadCatalog();
  const catalog = catalogResult.ok ? catalogResult.value : undefined;
  if (!catalog) console.warn('[Alduin] Catalog load failed — pricing/tokenizer fallback active');

  // ── Auth + audit ──────────────────────────────────────────────────────────
  const authDb = openSqlite(dbPath);
  const roleResolver = RoleResolver.create(authDb);
  const policyEngine = new PolicyEngine(existsSync(POLICY_FILE) ? POLICY_FILE : undefined);

  // Audit HMAC key — independent from the vault master secret.
  // Retrieved via keychain (keytar) or ALDUIN_AUDIT_HMAC_KEY env var.
  // Throws on startup if neither is available — this is intentional:
  // an unkeyed audit log can be forged, so we refuse to start.
  const { OSKeychain } = await import('./connectors/keychain.js');
  const auditKeychain = new OSKeychain();
  let auditHmacKey: string;
  try {
    auditHmacKey = await auditKeychain.getAuditHmacKey();
  } catch (err) {
    throw new Error(
      `Cannot obtain audit HMAC key. ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const auditLog = new AuditLog(AUDIT_LOG, auditHmacKey);
  verifyAuditLogOrThrow(auditLog);

  // ── Session store ─────────────────────────────────────────────────────────
  const sessionStore = new SessionStore(dbPath);
  const defaultTenant = config.tenants?.default_tenant_id ?? 'default';
  const sessionResolver = new SessionResolver(sessionStore, defaultTenant);

  // ── Runtime plane ─────────────────────────────────────────────────────────
  // Capture the OpenAI key for the ingestion pipeline BEFORE initProviders
  // calls scrubProviderEnv(), which removes it from process.env.
  // Use config.providers['openai']?.api_key_env to determine which env var to read.
  const openaiIngestionKey = config.providers['openai']
    ? (process.env[config.providers['openai'].api_key_env ?? 'OPENAI_API_KEY'] ?? undefined)
    : undefined;

  const registry = new ProviderRegistry();
  const loadedProviders = initProviders(config, registry, catalog);
  console.log(`[Alduin] Providers loaded: ${loadedProviders.join(', ') || 'none'}`);

  const tokenCounter = new TokenCounter(catalog);

  // Budget
  let budgetTracker: BudgetTracker;
  if (existsSync(BUDGET_STATE_FILE)) {
    try { budgetTracker = BudgetTracker.restore(BUDGET_STATE_FILE, config.budgets); }
    catch { budgetTracker = new BudgetTracker(config.budgets); }
  } else {
    budgetTracker = new BudgetTracker(config.budgets);
  }
  const budgetGuard = new BudgetGuard(budgetTracker);
  const scopedBudget = new ScopedBudgetTracker();

  // Ingestion
  const blobStore = new BlobStore(dbPath, blobsPath);
  const ingestionConfig = {
    ...DEFAULT_INGESTION_CONFIG,
    ...config.ingestion,
  };
  const ingestionPipeline = new IngestionPipeline(
    blobStore,
    ingestionConfig,
    openaiIngestionKey
  );

  // Summarizer, dispatcher, trace
  const classifierExecutor = config.executors[config.routing.classifier_model];
  const summarizerModel = classifierExecutor?.model ?? config.orchestrator.model;
  const summarizer = new ResultSummarizer(registry, { model: summarizerModel, max_tokens: 300 });
  const dispatcher = new ExecutorDispatcher(registry, config, budgetGuard, summarizer, tokenCounter);
  const traceLogger = new TraceLogger();

  // Event bus (in-memory, shared by all sessions)
  const eventBus = new AlduinEventBus();

  // Orchestrator + router (shared, stateless except memory managers per session)
  const orchestratorLoop = new OrchestratorLoop(
    config, registry, dispatcher, budgetGuard, tokenCounter, traceLogger
  );
  const classifier = new MessageClassifier(registry, config, tokenCounter);
  const router = new Router(config, classifier, orchestratorLoop, dispatcher, traceLogger, tokenCounter);

  // ── Per-session memory managers (created on demand) ───────────────────────
  const sessionMemory = new Map<string, MemoryManager>();

  function getOrCreateMemory(sessionId: string): MemoryManager {
    const existing = sessionMemory.get(sessionId);
    if (existing) return existing;

    const mgr = new MemoryManager(
      new HotMemory(config.memory?.hot_turns ?? 3),
      new WarmMemory(registry, config, tokenCounter),
      new ColdMemory(registry, config),
      new ContextReferenceDetector(),
      config,
      tokenCounter
    );
    sessionMemory.set(sessionId, mgr);
    return mgr;
  }

  // ── Per-session renderer subscribers (created on demand) ──────────────────
  const sessionRenderers = new Map<string, RendererSubscriber>();

  function getOrCreateRenderer(
    sessionId: string,
    adapter: ChannelAdapter,
    threadId: string
  ): RendererSubscriber {
    const existing = sessionRenderers.get(sessionId);
    if (existing) return existing;

    const sub = new RendererSubscriber(eventBus, adapter, threadId, sessionId);
    sub.start();
    sessionRenderers.set(sessionId, sub);
    return sub;
  }

  // ── Connectors (stub map — extend as connectors are registered) ───────────
  const oauthHelpers = new Map();

  const startedAt = new Date();

  // ── Core event handler ────────────────────────────────────────────────────

  /**
   * This is the critical integration point:
   * NormalizedEvent + Session → policy → command router → runtime plane → renderer
   */
  async function handleNormalizedEvent(
    event: NormalizedEvent,
    session: Session,
    adapter: ChannelAdapter
  ): Promise<void> {
    const { ConnectorRegistry } = await import('./connectors/framework.js');
    const connectorRegistry = new ConnectorRegistry();

    // ── 1. Policy gate ───────────────────────────────────────────────────────
    const role = roleResolver.resolve(session.tenant_id, event.external.user_id, event.external.is_group);
    const verdict: PolicyVerdict = policyEngine.evaluate({
      channel: event.channel,
      tenant_id: session.tenant_id,
      user_id: event.external.user_id,
      user_role: role,
      is_group: event.external.is_group,
      session_id: session.session_id,
    });

    const target: ChannelTarget = { thread_id: event.external.thread_id };

    if (!verdict.allowed) {
      await adapter.send({
        text: `⛔ ${verdict.denied_reason ?? 'Action not permitted in this context.'}`,
        parse_mode: 'plain',
      } as PresentationPayload, target);
      return;
    }

    // ── 2. Command routing (before pre-classifier) ──────────────────────────
    const text = event.text ?? '';

    if (text.startsWith('/alduin')) {
      const result = handleAdminCommand(text, {
        tenant_id: session.tenant_id,
        user_id: event.external.user_id,
        user_role: role,
        session_id: session.session_id,
        is_group: event.external.is_group,
        group_id: event.external.is_group ? event.external.thread_id : undefined,
      }, {
        roleResolver,
        policyEngine,
        auditLog,
        budgetTracker,
        scopedBudget,
        traceLogger,
        startedAt,
        activeSessionCount: () => sessionMemory.size,
      });
      if (result.handled && result.reply) {
        await adapter.send({ text: result.reply, parse_mode: 'plain' } as PresentationPayload, target);
      }
      return;
    }

    if (isCommand(text) && text.startsWith('/connect')) {
      const result = handleConnectCommand(event, session, connectorRegistry, oauthHelpers);
      if (result.handled && result.reply) {
        await adapter.send({ text: result.reply, parse_mode: 'plain' } as PresentationPayload, target);
      }
      return;
    }

    // ── 3. Scoped budget check ───────────────────────────────────────────────
    const groupId = event.external.is_group ? event.external.thread_id : undefined;
    const budgetCheck = scopedBudget.checkScoped(event.external.user_id, groupId);
    if (!budgetCheck.allowed) {
      await adapter.send({
        text: `⛔ Budget exceeded for ${budgetCheck.denied_scope ?? 'this scope'}.`,
        parse_mode: 'plain',
      } as PresentationPayload, target);
      return;
    }

    // ── 4. Typing indicator (within 500ms) ──────────────────────────────────
    const typingTimer = setTimeout(async () => {
      try {
        await adapter.send({ text: '⏳', parse_mode: 'plain' } as PresentationPayload, target);
      } catch { /* ignore if fails */ }
    }, 450);

    // ── 5. Memory ────────────────────────────────────────────────────────────
    const memory = getOrCreateMemory(session.session_id);
    const { recentTurns } = await memory.buildContext(text, config.orchestrator.model);
    const history = recentTurns.map((t) => ({
      role: t.role,
      content: t.content,
      timestamp: t.timestamp,
    }));

    // ── 6. Progress edits after 3s ───────────────────────────────────────────
    const renderer = getOrCreateRenderer(session.session_id, adapter, event.external.thread_id);
    let progressSent: ReturnType<typeof adapter.send> | null = null;
    const progressTimer = setTimeout(async () => {
      progressSent = adapter.send({
        text: '⏳ Working on it…',
        parse_mode: 'plain',
      } as PresentationPayload, target);
    }, 3000);

    try {
      clearTimeout(typingTimer);

      // ── 7. Route through pre-classifier → orchestrator ────────────────────
      const { response, trace } = await router.route(text, history, verdict);
      clearTimeout(progressTimer);

      // Record in memory
      await memory.addTurn({ role: 'user', content: text, timestamp: new Date() });
      await memory.addTurn({ role: 'assistant', content: response, timestamp: new Date() });

      // Record scoped usage
      if (trace.total_cost_usd > 0) {
        scopedBudget.trackScoped(event.external.user_id, groupId, trace.total_cost_usd);
      }

      // ── 8. Render the response ─────────────────────────────────────────────
      // Add trace button
      const traceId = `${trace.task_id}`;
      const responseText = response + (trace.total_cost_usd > 0
        ? `\n\n<i>$${trace.total_cost_usd.toFixed(4)} · ${trace.total_latency_ms}ms</i>`
        : '');

      if (progressSent) {
        // We already sent a progress message — try to edit it
        try {
          const ref = await progressSent;
          await adapter.edit(ref, { text: responseText, parse_mode: 'html' } as PresentationPayload);
        } catch {
          await adapter.send({ text: responseText, parse_mode: 'html' } as PresentationPayload, target);
        }
      } else {
        await adapter.send({ text: responseText, parse_mode: 'html' } as PresentationPayload, target);
      }
    } catch (err) {
      clearTimeout(typingTimer);
      clearTimeout(progressTimer);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Alduin] Event handler error: ${msg}`);
      await adapter.send({
        text: '⚠️ Something went wrong processing your request. Use /trace to investigate.',
        parse_mode: 'plain',
      } as PresentationPayload, target);
    }
  }

  // ── Build raw-event handler for a given adapter ───────────────────────────

  function buildRawHandler(adapter: ChannelAdapter) {
    const tgConfig = config.channels?.telegram;
    const channelDownloadConfig: ChannelDownloadConfig = {
      telegram: tgConfig?.token_env
        ? { bot_token: process.env[tgConfig.token_env] ?? '' }
        : undefined,
    };

    return function handleRawEvent(raw: RawChannelEvent): void {
      let normalizedPromise: Promise<NormalizedEvent | null>;

      if (raw.channel === 'telegram') {
        normalizedPromise = parseAndIngestUpdate(
          raw.payload as Update,
          ingestionPipeline,
          channelDownloadConfig,
          ingestionConfig.attachment_timeout_ms ?? 30_000
        );
      } else {
        normalizedPromise = Promise.resolve(null);
      }

      normalizedPromise.then((normalized) => {
        if (!normalized) return;

        const session = sessionResolver.resolve({
          channel: normalized.channel,
          thread_id: normalized.external.thread_id,
          user_id: normalized.external.user_id,
          is_group: normalized.external.is_group,
        });

        void handleNormalizedEvent(normalized, session, adapter);
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Alduin] Raw event processing error: ${message}`);
      });
    };
  }

  // ── Gateway + adapters ────────────────────────────────────────────────────

  const gateway = new WebhookGateway();

  const tgConfig = config.channels?.telegram;
  let tgAdapter: TelegramAdapter | null = null;

  if (tgConfig?.enabled) {
    const token = process.env[tgConfig.token_env] ?? '';
    if (!token) {
      console.warn(`[Alduin] ${tgConfig.token_env} not set — Telegram adapter disabled`);
    } else {
      const webhookSecret = tgConfig.webhook_secret_env
        ? (process.env[tgConfig.webhook_secret_env] ?? undefined)
        : undefined;

      tgAdapter = new TelegramAdapter({
        mode: tgConfig.mode,
        token,
        webhook_url: tgConfig.webhook_url,
        webhook_secret: webhookSecret,
      });

      tgAdapter.onEvent(buildRawHandler(tgAdapter));
      gateway.registerAdapter(tgAdapter);
    }
  }

  // Note: All secrets (including Telegram tokens) were already scrubbed
  // in initProviders() → scrubSecretEnv(config).

  // ── Return runtime handle ─────────────────────────────────────────────────

  return {
    gateway,
    sessionStore,

    async start(port = 3000) {
      // TODO: When an admin panel is added, it must bind to 127.0.0.1 on a
      // separate port — never expose it on the same interface as the webhook
      // gateway. The gateway port should be firewalled to only accept traffic
      // from webhook provider IP ranges (e.g. Telegram's 149.154.160.0/20).
      await new Promise<void>((resolve) => {
        gateway.app.listen(port, () => {
          console.log(`[Alduin] Listening on :${port}`);
          resolve();
        });
      });
      if (tgAdapter && tgConfig?.mode === 'longpoll') {
        await tgAdapter.start();
      }
    },

    async stop() {
      // End all sessions and flush memory
      for (const [, mgr] of sessionMemory) {
        await mgr.endSession();
      }
      // Stop renderer subscribers
      for (const [, sub] of sessionRenderers) {
        sub.stop();
      }
      // Persist budget
      try { budgetTracker.persist(BUDGET_STATE_FILE); } catch { /* best effort */ }
      gateway.close();
      eventBus.close();
      blobStore.close();
      sessionStore.close();
      policyEngine.close();
    },
  };
}
