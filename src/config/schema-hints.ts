// ─────────────────────────────────────────────────────────────
// Adapted from OpenClaw (MIT, © Peter Steinberger)
//   Origin: src/config/schema.hints.ts
//   Origin SHA: 778ac4330aa32b9ce4482f0d1a3d4f744ff7f17f
//   Ported: 2026-04-15
// ─────────────────────────────────────────────────────────────

/**
 * UI metadata for every field and section in the Alduin config schema.
 *
 * Keys use the same dotted-path convention as ALDUIN_*__ env overrides:
 *   'orchestrator.model', 'providers.*', 'channels.telegram.token_env', …
 *
 * This data is consumed by:
 *   - scripts/generate-schema.ts  →  injects title/description into JSON Schema
 *   - future alduin config set wizard  →  labels, placeholders, sensitivity hints
 *   - future Control UI  →  field grouping, advanced/basic modes
 *
 * Sensitive paths (api key env vars, tokens, secrets) can be flagged
 * explicitly with `sensitive: true`, or are auto-detected by
 * `isSensitivePath()` for paths not declared here.
 */

/** Metadata for a single config field or section. */
export interface FieldHint {
  /** Short display label — used as JSON Schema `title`. */
  label?: string;
  /** Longer explanatory text — used as JSON Schema `description`. */
  help?: string;
  /** Example value shown in placeholder / wizard prompts. */
  placeholder?: string;
  /**
   * When true, the field value is masked in logs, UIs, and CLI output.
   * Auto-applied by `isSensitivePath()` for unlisted paths matching
   * token/secret/api_key patterns.
   */
  sensitive?: boolean;
  /** When true, the field is hidden from beginner / wizard views. */
  advanced?: boolean;
}

/** Full hint table keyed by dotted config path. `*` is the record wildcard. */
export type SchemaHints = Record<string, FieldHint>;

// ── Sensitive-path auto-detection ────────────────────────────────────────────

/** Patterns whose matching path segments indicate a secret value. */
const SENSITIVE_PATTERNS: RegExp[] = [
  /api[_-]?key/i,
  /token(_env)?$/i,
  /secret(_env)?$/i,
  /password/i,
];

/**
 * Returns true when `path` matches a sensitive-value naming pattern
 * and is not explicitly overridden to `sensitive: false` in SCHEMA_HINTS.
 */
export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(path));
}

// ── Hint table ────────────────────────────────────────────────────────────────

export const SCHEMA_HINTS: SchemaHints = {

  // ── Top-level ───────────────────────────────────────────────────────────────
  catalog_version: {
    label: 'Catalog Version',
    help: 'Model catalog revision this config was validated against. Set automatically by `alduin catalog sync`.',
    advanced: true,
  },

  // ── Orchestrator ────────────────────────────────────────────────────────────
  orchestrator: {
    label: 'Orchestrator',
    help: 'Planning model configuration. The orchestrator decomposes requests into steps but never executes them directly.',
  },
  'orchestrator.model': {
    label: 'Orchestrator Model',
    help: 'Fully-qualified model string (provider/name). Must appear in the active catalog.',
    placeholder: 'anthropic/claude-sonnet-4-6',
  },
  'orchestrator.max_planning_tokens': {
    label: 'Max Planning Tokens',
    help: 'Maximum tokens the orchestrator may consume on a single planning call.',
    advanced: true,
    placeholder: '4000',
  },
  'orchestrator.context_strategy': {
    label: 'Context Strategy',
    help: 'How the orchestrator manages its context window. "sliding_window" drops the oldest turns when the budget is full.',
    advanced: true,
    placeholder: 'sliding_window',
  },
  'orchestrator.context_window': {
    label: 'Context Window (tokens)',
    help: 'Token budget for the orchestrator context. Should be ≤ the model\'s supported context length.',
    advanced: true,
    placeholder: '16000',
  },

  // ── Executors ───────────────────────────────────────────────────────────────
  executors: {
    label: 'Executors',
    help: 'Named executor configurations. Each executor is a stateless model that performs a specific task type (code, research, content, …).',
  },
  'executors.*': {
    label: 'Executor',
    help: 'A single executor definition. Executors receive only the task instruction — no conversation history.',
  },
  'executors.*.model': {
    label: 'Model',
    help: 'Fully-qualified model string for this executor.',
    placeholder: 'anthropic/claude-haiku-4',
  },
  'executors.*.max_tokens': {
    label: 'Max Output Tokens',
    help: 'Maximum tokens the executor may generate per task.',
    placeholder: '8000',
  },
  'executors.*.tools': {
    label: 'Allowed Tools',
    help: 'Tool names this executor may call. An empty list means no tools.',
    advanced: true,
  },
  'executors.*.context': {
    label: 'Context Mode',
    help: '"task_only" — receives the task instruction only. "task_plus_style_guide" — also receives the style guide. "message_only" — receives the raw user message.',
    advanced: true,
  },
  'executors.*.request_timeout_ms': {
    label: 'Request Timeout (ms)',
    help: 'Per-request SDK timeout in milliseconds. Overrides the provider SDK default to prevent runaway requests.',
    advanced: true,
    placeholder: '60000',
  },

  // ── Providers ───────────────────────────────────────────────────────────────
  providers: {
    label: 'Providers',
    help: 'LLM provider configurations keyed by alias (e.g. "anthropic", "openai", "ollama").',
  },
  'providers.*': {
    label: 'Provider',
    help: 'Configuration for a single LLM provider.',
  },
  'providers.*.api_key_env': {
    label: 'API Key Env Var',
    help: 'Name of the environment variable holding the API key. The value is never stored in config.',
    sensitive: true,
    placeholder: 'ANTHROPIC_API_KEY',
  },
  'providers.*.base_url': {
    label: 'Base URL',
    help: 'Override the provider\'s default API endpoint. Required for self-hosted or proxy deployments.',
    placeholder: 'https://api.anthropic.com',
  },
  'providers.*.api_type': {
    label: 'API Type',
    help: '"openai-compatible" enables the OpenAI SDK with a custom base URL. Leave unset for native provider SDKs.',
    advanced: true,
    placeholder: 'openai-compatible',
  },

  // ── Routing ─────────────────────────────────────────────────────────────────
  routing: {
    label: 'Routing',
    help: 'Pre-classifier and complexity-threshold routing settings.',
  },
  'routing.pre_classifier': {
    label: 'Enable Pre-classifier',
    help: 'When true, a cheap classifier scores each message before the orchestrator sees it. Low-complexity messages bypass orchestration entirely.',
  },
  'routing.classifier_model': {
    label: 'Classifier Executor',
    help: 'Name of the executor used as the complexity classifier. Must be defined in the `executors` section.',
    placeholder: 'classifier',
  },
  'routing.complexity_threshold': {
    label: 'Complexity Threshold',
    help: 'Classifier score (0–1) below which a message is routed directly to the quick executor, skipping full orchestration. 0.6 is a sensible starting point.',
    placeholder: '0.6',
  },

  // ── Budgets ─────────────────────────────────────────────────────────────────
  budgets: {
    label: 'Budgets',
    help: 'Spending limits enforced before any LLM call is dispatched.',
  },
  'budgets.daily_limit_usd': {
    label: 'Daily Limit (USD)',
    help: 'Maximum total LLM spend per calendar day across all sessions and users.',
    placeholder: '10.00',
  },
  'budgets.per_task_limit_usd': {
    label: 'Per-task Limit (USD)',
    help: 'Hard ceiling on the cost of a single task execution. Protects against runaway orchestration chains.',
    placeholder: '2.00',
  },
  'budgets.warning_threshold': {
    label: 'Warning Threshold',
    help: 'Fraction of the daily limit (0–1) at which a warning is emitted in logs. 0.8 warns at 80% usage.',
    placeholder: '0.8',
  },
  'budgets.per_model_limits': {
    label: 'Per-model Limits',
    help: 'Optional per-model daily spending caps keyed by fully-qualified model string.',
    advanced: true,
  },

  // ── Fallbacks ───────────────────────────────────────────────────────────────
  fallbacks: {
    label: 'Fallback Chains',
    help: 'Ordered fallback model lists keyed by primary model string. When a model fails (rate limit, outage), the next in the list is tried in order.',
    advanced: true,
  },

  // ── Memory ──────────────────────────────────────────────────────────────────
  memory: {
    label: 'Memory',
    help: 'Tiered memory configuration: hot (in-context turns) → warm (rolling summary) → cold (vector retrieval).',
  },
  'memory.hot_turns': {
    label: 'Hot Turns',
    help: 'Number of recent conversation turns kept directly in the orchestrator context.',
    placeholder: '6',
  },
  'memory.warm_max_tokens': {
    label: 'Warm Summary Max Tokens',
    help: 'Token budget for the rolling warm-memory summary. Older content is compressed when this limit is reached.',
    advanced: true,
    placeholder: '2000',
  },
  'memory.cold_enabled': {
    label: 'Cold Memory Enabled',
    help: 'When true, older turns are embedded and stored for semantic retrieval from a vector database.',
    advanced: true,
  },
  'memory.cold_embedding_model': {
    label: 'Embedding Model',
    help: 'Fully-qualified model string used to generate cold-memory embeddings.',
    advanced: true,
    placeholder: 'openai/text-embedding-3-small',
  },
  'memory.cold_similarity_threshold': {
    label: 'Cold Similarity Threshold',
    help: 'Minimum cosine similarity (0–1) required for cold-memory retrieval to return a result.',
    advanced: true,
    placeholder: '0.75',
  },
  'memory.redact_pii': {
    label: 'Redact PII',
    help: 'Also redact emails and phone numbers when promoting turns to warm/cold memory. API keys and JWTs are always redacted.',
    advanced: true,
  },

  // ── Channels ────────────────────────────────────────────────────────────────
  channels: {
    label: 'Channels',
    help: 'Messaging channel adapters.',
  },
  'channels.telegram': {
    label: 'Telegram',
    help: 'Telegram bot channel.',
  },
  'channels.telegram.enabled': {
    label: 'Enabled',
    help: 'Activates the Telegram channel adapter.',
  },
  'channels.telegram.mode': {
    label: 'Polling Mode',
    help: '"longpoll" — bot polls Telegram (no public URL required, slightly higher latency). "webhook" — Telegram pushes updates to your HTTPS endpoint (faster, requires a reachable public URL).',
  },
  'channels.telegram.token_env': {
    label: 'Bot Token Env Var',
    help: 'Name of the environment variable holding the Telegram bot token from @BotFather.',
    sensitive: true,
    placeholder: 'TELEGRAM_BOT_TOKEN',
  },
  'channels.telegram.webhook_url': {
    label: 'Webhook URL',
    help: 'Public HTTPS URL Telegram will POST updates to. Required in webhook mode.',
    placeholder: 'https://yourhost.example.com/webhook/telegram',
  },
  'channels.telegram.webhook_secret_env': {
    label: 'Webhook Secret Env Var',
    help: 'Name of the environment variable holding the webhook secret token used to verify Telegram requests.',
    sensitive: true,
    placeholder: 'ALDUIN_WEBHOOK_SECRET',
  },

  // ── Tenants ─────────────────────────────────────────────────────────────────
  tenants: {
    label: 'Tenants',
    help: 'Multi-tenant deployment isolation.',
    advanced: true,
  },
  'tenants.default_tenant_id': {
    label: 'Default Tenant ID',
    help: 'Tenant identifier applied when an incoming event carries no tenant context.',
    advanced: true,
    placeholder: 'default',
  },

  // ── Ingestion ────────────────────────────────────────────────────────────────
  ingestion: {
    label: 'Attachment Ingestion',
    help: 'Pipeline settings for files, images, and audio sent to the bot.',
    advanced: true,
  },
  'ingestion.max_bytes': {
    label: 'Max File Size (bytes)',
    help: 'Maximum allowed attachment size. Attachments exceeding this are rejected. Default: 25 MB.',
    advanced: true,
    placeholder: '26214400',
  },
  'ingestion.ocr_enabled': {
    label: 'OCR Enabled',
    help: 'Enable optical character recognition for image attachments. Requires the optional tesseract.js peer dependency.',
    advanced: true,
  },
  'ingestion.stt_enabled': {
    label: 'Speech-to-Text Enabled',
    help: 'Enable transcription for voice/audio attachments via OpenAI Whisper.',
    advanced: true,
  },
  'ingestion.attachment_timeout_ms': {
    label: 'Attachment Timeout (ms)',
    help: 'Per-attachment pipeline timeout. Attachments that take longer to process are rejected.',
    advanced: true,
    placeholder: '30000',
  },
  'ingestion.ttl_hours': {
    label: 'Blob TTL (hours)',
    help: 'How long attachment blobs are retained in the store before the cleanup sweep removes them.',
    advanced: true,
    placeholder: '24',
  },
  'ingestion.local_root': {
    label: 'Local Ingestion Root',
    help: 'Filesystem path prefix allowed for local file ingestion. Only files under this directory can be read. Requires ALDUIN_ALLOW_LOCAL_INGESTION=1.',
    advanced: true,
    placeholder: './uploads',
  },
};
// drift-test
