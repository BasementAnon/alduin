import { describe, it, expect, afterEach } from 'vitest';
import { ProviderRegistry, scrubSecretEnv } from '../providers/registry.js';
import type { LLMProvider } from '../types/llm.js';
import type { AlduinConfig } from '../config/types.js';

/** Minimal mock provider for testing */
function mockProvider(id: string): LLMProvider {
  return {
    id,
    complete: async () => ({ ok: false as const, error: { type: 'provider_error' as const, message: 'mock', retryable: false } }),
    countTokens: () => 0,
    estimateCost: () => 0,
  };
}

describe('ProviderRegistry', () => {
  it('registers and retrieves providers', () => {
    const registry = new ProviderRegistry();
    const provider = mockProvider('anthropic');
    registry.register('anthropic', provider);

    expect(registry.get('anthropic')).toBe(provider);
    expect(registry.has('anthropic')).toBe(true);
    expect(registry.get('openai')).toBeUndefined();
  });

  it('resolves provider from model string', () => {
    const registry = new ProviderRegistry();
    registry.register('anthropic', mockProvider('anthropic'));

    const resolved = registry.resolveProvider('anthropic/claude-sonnet-4-6');
    expect(resolved?.id).toBe('anthropic');
  });

  it('extracts model name from qualified string', () => {
    const registry = new ProviderRegistry();
    expect(registry.resolveModelName('anthropic/claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(registry.resolveModelName('ollama/qwen2.5-7b')).toBe('qwen2.5-7b');
  });

  it('lists registered providers', () => {
    const registry = new ProviderRegistry();
    registry.register('anthropic', mockProvider('anthropic'));
    registry.register('openai', mockProvider('openai'));

    expect(registry.listProviders()).toEqual(['anthropic', 'openai']);
  });
});

describe('scrubSecretEnv', () => {
  const ALL_SECRET_KEYS = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'DEEPSEEK_API_KEY',
    'GOOGLE_API_KEY',
    'MY_CUSTOM_API_KEY',
    'ALDUIN_VAULT_SECRET',
    'ALDUIN_AUDIT_HMAC_KEY',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_WEBHOOK_SECRET',
  ] as const;

  afterEach(() => {
    // Clean up any leftover values after each test
    for (const key of ALL_SECRET_KEYS) {
      delete process.env[key];
    }
  });

  it('removes all legacy provider API key env vars from process.env', () => {
    process.env['OPENAI_API_KEY'] = 'sk-test-openai';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    process.env['DEEPSEEK_API_KEY'] = 'sk-ds-test';
    process.env['GOOGLE_API_KEY'] = 'goog-test';

    const config: AlduinConfig = {
      orchestrator: { model: 'anthropic/claude-sonnet-4-6', max_planning_tokens: 5000, context_strategy: 'task_only', context_window: 128000 },
      executors: {},
      providers: {},
      routing: { pre_classifier: false, classifier_model: 'classifier', complexity_threshold: 0.5 },
      budgets: { daily_limit_usd: 100, per_task_limit_usd: 10, warning_threshold: 0.8 },
    };

    scrubSecretEnv(config);

    expect(process.env['OPENAI_API_KEY']).toBeUndefined();
    expect(process.env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(process.env['DEEPSEEK_API_KEY']).toBeUndefined();
    expect(process.env['GOOGLE_API_KEY']).toBeUndefined();
  });

  it('removes custom api_key_env from provider configs', () => {
    process.env['MY_CUSTOM_API_KEY'] = 'custom-secret-123';
    process.env['ANOTHER_API_KEY'] = 'another-secret-456';

    const config: AlduinConfig = {
      orchestrator: { model: 'anthropic/claude-sonnet-4-6', max_planning_tokens: 5000, context_strategy: 'task_only', context_window: 128000 },
      executors: {},
      providers: {
        myProvider: { api_key_env: 'MY_CUSTOM_API_KEY' },
        anotherProvider: { api_key_env: 'ANOTHER_API_KEY' },
      },
      routing: { pre_classifier: false, classifier_model: 'classifier', complexity_threshold: 0.5 },
      budgets: { daily_limit_usd: 100, per_task_limit_usd: 10, warning_threshold: 0.8 },
    };

    scrubSecretEnv(config);

    expect(process.env['MY_CUSTOM_API_KEY']).toBeUndefined();
    expect(process.env['ANOTHER_API_KEY']).toBeUndefined();
  });

  it('removes vault and audit secrets', () => {
    process.env['ALDUIN_VAULT_SECRET'] = 'vault-secret-xyz';
    process.env['ALDUIN_AUDIT_HMAC_KEY'] = 'audit-key-abc';

    const config: AlduinConfig = {
      orchestrator: { model: 'anthropic/claude-sonnet-4-6', max_planning_tokens: 5000, context_strategy: 'task_only', context_window: 128000 },
      executors: {},
      providers: {},
      routing: { pre_classifier: false, classifier_model: 'classifier', complexity_threshold: 0.5 },
      budgets: { daily_limit_usd: 100, per_task_limit_usd: 10, warning_threshold: 0.8 },
    };

    scrubSecretEnv(config);

    expect(process.env['ALDUIN_VAULT_SECRET']).toBeUndefined();
    expect(process.env['ALDUIN_AUDIT_HMAC_KEY']).toBeUndefined();
  });

  it('removes Telegram token env vars from config', () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'bot-token-123';
    process.env['TELEGRAM_WEBHOOK_SECRET'] = 'webhook-secret-456';

    const config: AlduinConfig = {
      orchestrator: { model: 'anthropic/claude-sonnet-4-6', max_planning_tokens: 5000, context_strategy: 'task_only', context_window: 128000 },
      executors: {},
      providers: {},
      routing: { pre_classifier: false, classifier_model: 'classifier', complexity_threshold: 0.5 },
      budgets: { daily_limit_usd: 100, per_task_limit_usd: 10, warning_threshold: 0.8 },
      channels: {
        telegram: {
          enabled: true,
          mode: 'longpoll',
          token_env: 'TELEGRAM_BOT_TOKEN',
          webhook_secret_env: 'TELEGRAM_WEBHOOK_SECRET',
        },
      },
    };

    scrubSecretEnv(config);

    expect(process.env['TELEGRAM_BOT_TOKEN']).toBeUndefined();
    expect(process.env['TELEGRAM_WEBHOOK_SECRET']).toBeUndefined();
  });

  it('removes only the telegram token env var when webhook_secret_env is not set', () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'bot-token-123';
    process.env['OTHER_SECRET'] = 'should-be-preserved';

    const config: AlduinConfig = {
      orchestrator: { model: 'anthropic/claude-sonnet-4-6', max_planning_tokens: 5000, context_strategy: 'task_only', context_window: 128000 },
      executors: {},
      providers: {},
      routing: { pre_classifier: false, classifier_model: 'classifier', complexity_threshold: 0.5 },
      budgets: { daily_limit_usd: 100, per_task_limit_usd: 10, warning_threshold: 0.8 },
      channels: {
        telegram: {
          enabled: true,
          mode: 'longpoll',
          token_env: 'TELEGRAM_BOT_TOKEN',
        },
      },
    };

    scrubSecretEnv(config);

    expect(process.env['TELEGRAM_BOT_TOKEN']).toBeUndefined();
    expect(process.env['OTHER_SECRET']).toBe('should-be-preserved');
  });

  it('scrubs all configured secrets in a realistic scenario', () => {
    // Set up a variety of secrets
    process.env['OPENAI_API_KEY'] = 'sk-openai-test';
    process.env['CUSTOM_LLM_KEY'] = 'custom-llm-secret';
    process.env['ALDUIN_VAULT_SECRET'] = 'vault-master-key';
    process.env['ALDUIN_AUDIT_HMAC_KEY'] = 'audit-hmac-key';
    process.env['TELEGRAM_BOT_TOKEN'] = 'telegram-bot-secret';
    process.env['TELEGRAM_WEBHOOK_SECRET'] = 'telegram-webhook-secret';
    process.env['PATH'] = '/usr/local/bin:/usr/bin';
    process.env['NODE_ENV'] = 'production';
    process.env['DEBUG'] = 'false';

    const config: AlduinConfig = {
      orchestrator: { model: 'anthropic/claude-sonnet-4-6', max_planning_tokens: 5000, context_strategy: 'task_only', context_window: 128000 },
      executors: {
        default: { model: 'openai/gpt-4', max_tokens: 2000, tools: [], context: 'task_only' },
      },
      providers: {
        openai: { api_key_env: 'OPENAI_API_KEY' },
        custom: { api_key_env: 'CUSTOM_LLM_KEY', base_url: 'https://custom.api.com' },
      },
      routing: { pre_classifier: false, classifier_model: 'classifier', complexity_threshold: 0.5 },
      budgets: { daily_limit_usd: 100, per_task_limit_usd: 10, warning_threshold: 0.8 },
      channels: {
        telegram: {
          enabled: true,
          mode: 'longpoll',
          token_env: 'TELEGRAM_BOT_TOKEN',
          webhook_secret_env: 'TELEGRAM_WEBHOOK_SECRET',
        },
      },
    };

    scrubSecretEnv(config);

    // All secrets should be scrubbed
    expect(process.env['OPENAI_API_KEY']).toBeUndefined();
    expect(process.env['CUSTOM_LLM_KEY']).toBeUndefined();
    expect(process.env['ALDUIN_VAULT_SECRET']).toBeUndefined();
    expect(process.env['ALDUIN_AUDIT_HMAC_KEY']).toBeUndefined();
    expect(process.env['TELEGRAM_BOT_TOKEN']).toBeUndefined();
    expect(process.env['TELEGRAM_WEBHOOK_SECRET']).toBeUndefined();

    // Non-secret infra vars should be preserved
    expect(process.env['PATH']).toBe('/usr/local/bin:/usr/bin');
    expect(process.env['NODE_ENV']).toBe('production');
    expect(process.env['DEBUG']).toBe('false');
  });

  it('is idempotent when called multiple times', () => {
    process.env['OPENAI_API_KEY'] = 'sk-test';
    process.env['ALDUIN_VAULT_SECRET'] = 'vault-secret';

    const config: AlduinConfig = {
      orchestrator: { model: 'anthropic/claude-sonnet-4-6', max_planning_tokens: 5000, context_strategy: 'task_only', context_window: 128000 },
      executors: {},
      providers: { openai: { api_key_env: 'OPENAI_API_KEY' } },
      routing: { pre_classifier: false, classifier_model: 'classifier', complexity_threshold: 0.5 },
      budgets: { daily_limit_usd: 100, per_task_limit_usd: 10, warning_threshold: 0.8 },
    };

    // First call
    scrubSecretEnv(config);
    expect(process.env['OPENAI_API_KEY']).toBeUndefined();

    // Second call on already-clean env — must not throw
    expect(() => scrubSecretEnv(config)).not.toThrow();
    expect(process.env['OPENAI_API_KEY']).toBeUndefined();
  });

  it('does not disturb unrelated env vars', () => {
    process.env['MY_APP_VAR'] = 'keep-me';
    process.env['OPENAI_API_KEY'] = 'sk-test';
    process.env['SOME_OTHER_CONFIG'] = 'also-keep-me';

    const config: AlduinConfig = {
      orchestrator: { model: 'anthropic/claude-sonnet-4-6', max_planning_tokens: 5000, context_strategy: 'task_only', context_window: 128000 },
      executors: {},
      providers: { openai: { api_key_env: 'OPENAI_API_KEY' } },
      routing: { pre_classifier: false, classifier_model: 'classifier', complexity_threshold: 0.5 },
      budgets: { daily_limit_usd: 100, per_task_limit_usd: 10, warning_threshold: 0.8 },
    };

    scrubSecretEnv(config);

    expect(process.env['MY_APP_VAR']).toBe('keep-me');
    expect(process.env['SOME_OTHER_CONFIG']).toBe('also-keep-me');
    expect(process.env['OPENAI_API_KEY']).toBeUndefined();
  });
});
