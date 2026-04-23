/** Thrown by any step when the user presses Ctrl-C / selects cancel. */
export class WizardCancelledError extends Error {
  constructor() {
    super('Wizard cancelled by user');
    this.name = 'WizardCancelledError';
  }
}

// ── Step result types ─────────────────────────────────────────────────────────

/** Step 1: Welcome + mode selection */
export type WizardMode = 'fresh' | 'overwrite' | 'reconfigure';

export interface WelcomeAnswers {
  mode: WizardMode;
}

/** Step 2: Provider setup */
export interface ProviderSetup {
  id: string;
  apiKey?: string;
  baseUrl?: string;
  apiType?: string;
  /** True if connectivity test passed. */
  connected: boolean;
}

export interface ProviderAnswers {
  providers: ProviderSetup[];
}

/** Step 3: Model assignment */
export interface ModelAssignment {
  orchestrator: string;
  classifier: string;
  code: string;
  research: string;
  content: string;
  quick: string;
}

export interface ModelAnswers {
  /** Fully-qualified model strings per role. */
  assignments: ModelAssignment;
  /** Whether the user took the fast-track defaults. */
  usedDefaults: boolean;
}

/** Legacy compat — the old shape used by existing builders. */
export interface LegacyModelAnswers {
  orchestratorModel: string;
  classifierModel: string;
}

/** Step 4: Budget configuration */
export interface BudgetAnswers {
  dailyLimitUsd: number;
  /** 0–1 fraction of daily limit at which warnings are emitted. */
  warningThreshold: number;
  /** Per-task spending cap in USD. */
  perTaskLimitUsd: number;
  /** Optional per-model caps keyed by fully-qualified model string. */
  perModelLimits?: Record<string, number>;
}

/** Step 5: Channel setup */
export interface ChannelAnswers {
  channel: 'telegram' | 'cli' | 'both';
  mode: 'longpoll' | 'webhook';
  /** Full HTTPS webhook URL (only set when mode === 'webhook'). */
  webhookUrl?: string;
  /** Telegram bot token from @BotFather (undefined when channel is 'cli'). */
  botToken?: string;
  /**
   * Auto-generated webhook HMAC secret (only set when mode === 'webhook').
   * Always 64 hex chars.
   */
  webhookSecret?: string;
  /** Bot username returned by getMe (set after validation). */
  botUsername?: string;
  /** Telegram user IDs allowed to interact with the bot. */
  allowedUserIds?: number[];
}

/** Step 6: Skills selection */
export interface SkillInfo {
  id: string;
  description: string;
  /** Which executor role this skill primarily uses. */
  executorRole: string;
}

export interface SkillsAnswers {
  /** Skill IDs that are enabled. */
  enabledSkills: string[];
  /** Full skill info for display purposes. */
  availableSkills: SkillInfo[];
}

/** Step 7: Owner bootstrap answers — seeds the first `owner` role for a tenant. */
export interface OwnerAnswers {
  /** Tenant to seed; defaults to the config's default_tenant_id. */
  tenantId: string;
  /**
   * Channel user ID for the owner (e.g. Telegram numeric user ID as string).
   * Undefined when the user chose to skip owner bootstrap in the wizard.
   */
  userId?: string;
}

// ── Accumulated state ─────────────────────────────────────────────────────────

/** Accumulated answers from all wizard steps — passed to the commit phase. */
export interface WizardState {
  welcome: WelcomeAnswers;
  providerSetup: ProviderAnswers;
  models: ModelAnswers;
  budget: BudgetAnswers;
  channel: ChannelAnswers;
  skills: SkillsAnswers;
  /** Owner seeding is optional — may be skipped during init. */
  owner?: OwnerAnswers;
}

// ── Self-test ─────────────────────────────────────────────────────────────────

export interface LlmPingResult {
  model: string;
  role: string;
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
  providerPings: LlmPingResult[];
}

// ── Token answers (legacy compat for paste-tokens) ────────────────────────────

export interface TokenAnswers {
  /** Telegram bot token from @BotFather (undefined when channel is 'cli'). */
  botToken?: string;
  /**
   * Auto-generated webhook HMAC secret (only set when mode === 'webhook').
   * Always 64 hex chars.
   */
  webhookSecret?: string;
}
