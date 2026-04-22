import { describe, it, expect } from 'vitest';
import { applyEnvOverrides } from './env-overrides.js';

function minimalRaw(): Record<string, unknown> {
  return {
    orchestrator: {
      model: 'anthropic/claude-sonnet-4-6',
      max_planning_tokens: 4000,
      context_strategy: 'sliding_window',
      context_window: 16000,
    },
    executors: {
      code: {
        model: 'anthropic/claude-sonnet-4-6',
        max_tokens: 8000,
        tools: [],
        context: 'task_only',
      },
    },
    providers: {
      anthropic: { api_key_env: 'ANTHROPIC_API_KEY' },
    },
    routing: {
      pre_classifier: true,
      classifier_model: 'code',
      complexity_threshold: 0.6,
    },
    budgets: {
      daily_limit_usd: 10,
      per_task_limit_usd: 2,
      warning_threshold: 0.8,
    },
  };
}

describe('applyEnvOverrides', () => {
  it('overrides a scalar field with a string value', () => {
    const raw = minimalRaw();
    applyEnvOverrides(raw, { ALDUIN_ORCHESTRATOR__MODEL: 'anthropic/claude-opus-4-6' });
    expect((raw.orchestrator as Record<string, unknown>)['model']).toBe(
      'anthropic/claude-opus-4-6'
    );
  });

  it('coerces string → number for numeric schema fields', () => {
    const raw = minimalRaw();
    applyEnvOverrides(raw, { ALDUIN_BUDGETS__DAILY_LIMIT_USD: '25.5' });
    expect((raw.budgets as Record<string, unknown>)['daily_limit_usd']).toBe(25.5);
  });

  it('coerces "true" → boolean for boolean schema fields', () => {
    const raw = minimalRaw();
    applyEnvOverrides(raw, { ALDUIN_ROUTING__PRE_CLASSIFIER: 'false' });
    expect((raw.routing as Record<string, unknown>)['pre_classifier']).toBe(false);
  });

  it('overrides a nested provider key (record path)', () => {
    const raw = minimalRaw();
    applyEnvOverrides(raw, {
      ALDUIN_PROVIDERS__ANTHROPIC__API_KEY_ENV: 'MY_CUSTOM_KEY',
    });
    const prov = (raw.providers as Record<string, Record<string, unknown>>)['anthropic'];
    expect(prov!['api_key_env']).toBe('MY_CUSTOM_KEY');
  });

  it('overrides a nested executor key (record path)', () => {
    const raw = minimalRaw();
    applyEnvOverrides(raw, { ALDUIN_EXECUTORS__CODE__MAX_TOKENS: '16000' });
    const exec = (raw.executors as Record<string, Record<string, unknown>>)['code'];
    expect(exec!['max_tokens']).toBe(16000);
  });

  it('env-var overrides take precedence over YAML values', () => {
    const raw = minimalRaw();
    // original YAML value
    expect(
      (raw.budgets as Record<string, unknown>)['warning_threshold']
    ).toBe(0.8);
    applyEnvOverrides(raw, { ALDUIN_BUDGETS__WARNING_THRESHOLD: '0.95' });
    expect(
      (raw.budgets as Record<string, unknown>)['warning_threshold']
    ).toBe(0.95);
  });

  it('ignores env vars that do not start with ALDUIN_', () => {
    const raw = minimalRaw();
    const before = JSON.stringify(raw);
    applyEnvOverrides(raw, {
      ANTHROPIC_API_KEY: 'sk-xyz',
      OTHER_VAR: '123',
      PATH: '/usr/bin',
    });
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('ignores ALDUIN_ vars with empty values', () => {
    const raw = minimalRaw();
    const before = JSON.stringify(raw);
    applyEnvOverrides(raw, { ALDUIN_ORCHESTRATOR__MODEL: '' });
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('throws for an unknown top-level path', () => {
    const raw = minimalRaw();
    expect(() =>
      applyEnvOverrides(raw, { ALDUIN_NONEXISTENT__KEY: 'value' })
    ).toThrow(/unknown config path/);
  });

  it('throws for an unknown nested path within a known section', () => {
    const raw = minimalRaw();
    expect(() =>
      applyEnvOverrides(raw, { ALDUIN_ORCHESTRATOR__BOGUS_FIELD: 'value' })
    ).toThrow(/unknown config path/);
  });

  it('creates the intermediate object when the parent key does not exist in raw', () => {
    const raw = minimalRaw();
    // memory is optional and absent from our minimal raw
    applyEnvOverrides(raw, { ALDUIN_MEMORY__HOT_TURNS: '5' });
    expect((raw.memory as Record<string, unknown>)['hot_turns']).toBe(5);
  });

  it('skips infrastructure env vars (ALDUIN_AUDIT_HMAC_KEY, ALDUIN_VAULT_SECRET, etc.)', () => {
    const raw = minimalRaw();
    const before = JSON.stringify(raw);
    // These are infrastructure secrets/flags, not config-path overrides.
    // applyEnvOverrides must silently skip them instead of throwing "unknown path".
    applyEnvOverrides(raw, {
      ALDUIN_AUDIT_HMAC_KEY: 'some-hmac-key',
      ALDUIN_VAULT_SECRET: 'some-vault-secret',
      ALDUIN_WEBHOOK_SECRET: 'some-webhook-secret',
      ALDUIN_ALLOW_LOCAL_INGESTION: '1',
      ALDUIN_TRUST_PROXY: '1',
      ALDUIN_ALLOW_UNSIGNED: '1',
      ALDUIN_PLUGIN_HOT_RELOAD: '1',
    });
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('handles multiple overrides in a single call', () => {
    const raw = minimalRaw();
    applyEnvOverrides(raw, {
      ALDUIN_BUDGETS__DAILY_LIMIT_USD: '20',
      ALDUIN_BUDGETS__PER_TASK_LIMIT_USD: '3',
      ALDUIN_ROUTING__COMPLEXITY_THRESHOLD: '0.5',
    });
    const b = raw.budgets as Record<string, unknown>;
    const r = raw.routing as Record<string, unknown>;
    expect(b['daily_limit_usd']).toBe(20);
    expect(b['per_task_limit_usd']).toBe(3);
    expect(r['complexity_threshold']).toBe(0.5);
  });
});
