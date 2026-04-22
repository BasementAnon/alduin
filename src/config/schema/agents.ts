import { z } from 'zod';

export const routingConfigSchema = z.object({
  pre_classifier: z.boolean(),
  /** Executor name to use as the classifier. */
  classifier_model: z.string().min(1, 'classifier_model is required'),
  /** 0–1 threshold: messages below this score bypass the orchestrator. */
  complexity_threshold: z
    .number()
    .min(0, 'complexity_threshold must be >= 0')
    .max(1, 'complexity_threshold must be <= 1'),
});

/** Message routing configuration. */
export type RoutingConfig = z.output<typeof routingConfigSchema>;

export const budgetConfigSchema = z.object({
  daily_limit_usd: z.number().positive('daily_limit_usd must be a positive number'),
  per_task_limit_usd: z.number().positive('per_task_limit_usd must be a positive number'),
  /** Fraction of daily_limit at which warnings are emitted (0–1). */
  warning_threshold: z
    .number()
    .min(0, 'warning_threshold must be >= 0')
    .max(1, 'warning_threshold must be <= 1'),
  /** Per-model spending limits, keyed by fully-qualified model string. */
  per_model_limits: z
    .record(z.string(), z.number().positive('per-model limit must be a positive number'))
    .optional(),
});

/** Budget enforcement configuration. */
export type BudgetConfig = z.output<typeof budgetConfigSchema>;

export const memoryConfigSchema = z.object({
  /** Number of recent turns to keep in hot (in-context) memory. */
  hot_turns: z.number().int().positive('hot_turns must be a positive integer'),
  /** Maximum tokens for the warm rolling summary. */
  warm_max_tokens: z.number().positive('warm_max_tokens must be a positive number'),
  cold_enabled: z.boolean(),
  /** Model to use for generating embeddings. */
  cold_embedding_model: z.string().optional(),
  /** Cosine similarity threshold for cold memory retrieval. */
  cold_similarity_threshold: z.number().min(0).max(1).optional(),
  /**
   * When true, also redact emails and phone numbers when promoting turns to
   * warm/cold memory. Secrets (API keys, JWTs, etc.) are always redacted.
   */
  redact_pii: z.boolean().optional(),
});

/** Memory tier configuration. */
export type MemoryConfig = z.output<typeof memoryConfigSchema>;

export const tenantsConfigSchema = z.object({
  default_tenant_id: z.string().min(1),
});

/** Tenant/deployment isolation config. */
export type TenantsConfig = z.output<typeof tenantsConfigSchema>;

export const ingestionConfigSchema = z.object({
  /** Maximum allowed file size in bytes (default 25 MB). */
  max_bytes: z.number().int().positive().optional(),
  /** Enable OCR for images via tesseract.js (optional peer dep). */
  ocr_enabled: z.boolean().optional(),
  /** Enable STT for voice/audio via OpenAI Whisper. */
  stt_enabled: z.boolean().optional(),
  /** Per-attachment pipeline timeout in ms (default 30s). */
  attachment_timeout_ms: z.number().int().positive().optional(),
  /** Blob TTL in hours (default 24). */
  ttl_hours: z.number().int().positive().optional(),
  /**
   * Allowlist root for local file ingestion (default './uploads').
   * Only files under this directory can be read.
   * Requires ALDUIN_ALLOW_LOCAL_INGESTION=1.
   */
  local_root: z.string().optional(),
});

/** Attachment ingestion configuration. */
export type IngestionConfig = z.output<typeof ingestionConfigSchema>;

export const pluginsConfigSchema = z.object({
  /**
   * Additional plugin directories to load (relative to project root or absolute).
   * Built-in plugins (plugins/builtin/*) and @alduin-* npm packages are
   * always discovered; this field is for developer overrides and local plugins.
   */
  local: z.array(z.string()).optional(),
}).strict();

/** Plugin discovery configuration. */
export type PluginsConfig = z.output<typeof pluginsConfigSchema>;
