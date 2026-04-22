/** Thrown by any step when the user presses Ctrl-C / selects cancel. */
export class WizardCancelledError extends Error {
  constructor() {
    super('Wizard cancelled by user');
    this.name = 'WizardCancelledError';
  }
}

// ── Step result types ─────────────────────────────────────────────────────────

export interface ChannelAnswers {
  channel: 'telegram' | 'cli';
  mode: 'longpoll' | 'webhook';
  /** Full HTTPS webhook URL (only set when mode === 'webhook'). */
  webhookUrl?: string;
}

export interface TokenAnswers {
  /** Telegram bot token from @BotFather (undefined when channel is 'cli'). */
  botToken?: string;
  /**
   * Auto-generated webhook HMAC secret (only set when mode === 'webhook').
   * Always 64 hex chars.
   */
  webhookSecret?: string;
}

export interface ModelAnswers {
  /** Fully-qualified orchestrator model string (e.g. "anthropic/claude-sonnet-4-6"). */
  orchestratorModel: string;
  /** Fully-qualified classifier model string — should be a cheap/fast model. */
  classifierModel: string;
}

export interface BudgetAnswers {
  dailyLimitUsd: number;
  /** 0–1 fraction of daily limit at which warnings are emitted. */
  warningThreshold: number;
  /** Optional per-model caps keyed by fully-qualified model string. */
  perModelLimits?: Record<string, number>;
}

/** Owner bootstrap answers — seeds the first `owner` role for a tenant. */
export interface OwnerAnswers {
  /** Tenant to seed; defaults to the config's default_tenant_id. */
  tenantId: string;
  /**
   * Channel user ID for the owner (e.g. Telegram numeric user ID as string).
   * Undefined when the user chose to skip owner bootstrap in the wizard.
   */
  userId?: string;
}

/** Accumulated answers from all wizard steps — passed to the commit phase. */
export interface WizardState {
  channel: ChannelAnswers;
  tokens: TokenAnswers;
  models: ModelAnswers;
  budget: BudgetAnswers;
  /** Owner seeding is optional — may be skipped during init. */
  owner?: OwnerAnswers;
}

// ── Self-test ─────────────────────────────────────────────────────────────────

export interface LlmPingResult {
  model: string;
  role: 'classifier' | 'orchestrator';
  ok: boolean;
  latencyMs: number;
  estimatedCostUsd: number;
  error?: string;
}

export interface TelegramPingResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface SelfTestReport {
  telegram?: TelegramPingResult;
  classifier?: LlmPingResult;
  orchestrator?: LlmPingResult;
}
