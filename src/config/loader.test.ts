import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadConfig } from './loader.js';
import { writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const exampleConfigPath = path.resolve(__dirname, '../../config.example.yaml');

describe('loadConfig', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and validates config.example.yaml successfully', () => {
    const result = loadConfig(exampleConfigPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orchestrator.model).toBe('anthropic/claude-sonnet-4-6');
      expect(result.value.budgets.daily_limit_usd).toBe(10.0);
      expect(result.value.routing.complexity_threshold).toBe(0.6);
      expect(result.value.executors).toHaveProperty('code');
      expect(result.value.executors).toHaveProperty('research');
    }
  });

  it('returns file_not_found for a missing config file', () => {
    const result = loadConfig('/nonexistent/path/config.yaml');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('file_not_found');
      expect(result.error.message).toContain('not found');
    }
  });

  it('returns validation_error when a required field is missing', () => {
    const yaml = `
executors:
  code:
    model: anthropic/claude-sonnet-4-6
    max_tokens: 8000
    tools: []
    context: task_only
providers:
  anthropic:
    api_key_env: ANTHROPIC_API_KEY
routing:
  pre_classifier: true
  classifier_model: classifier
  complexity_threshold: 0.6
budgets:
  daily_limit_usd: 10.0
  per_task_limit_usd: 2.0
  warning_threshold: 0.8
`;
    const tmpPath = path.resolve(__dirname, '../../.tmp-test-config.yaml');
    writeFileSync(tmpPath, yaml, 'utf-8');

    try {
      const result = loadConfig(tmpPath);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('validation_error');
      }
    } finally {
      unlinkSync(tmpPath);
    }
  });

  it('returns validation_error for an invalid model string format', () => {
    const yaml = `
orchestrator:
  model: bad-model-no-slash
  max_planning_tokens: 4000
  context_strategy: sliding_window
  context_window: 16000
executors:
  code:
    model: anthropic/claude-sonnet-4-6
    max_tokens: 8000
    tools: []
    context: task_only
providers:
  anthropic:
    api_key_env: ANTHROPIC_API_KEY
routing:
  pre_classifier: true
  classifier_model: classifier
  complexity_threshold: 0.6
budgets:
  daily_limit_usd: 10.0
  per_task_limit_usd: 2.0
  warning_threshold: 0.8
`;
    const tmpPath = path.resolve(__dirname, '../../.tmp-test-invalid-model.yaml');
    writeFileSync(tmpPath, yaml, 'utf-8');

    try {
      const result = loadConfig(tmpPath);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('validation_error');
        expect(result.error.message).toContain('provider/model-name');
      }
    } finally {
      unlinkSync(tmpPath);
    }
  });

  it('returns validation_error for a negative budget value', () => {
    const yaml = `
orchestrator:
  model: anthropic/claude-sonnet-4-6
  max_planning_tokens: 4000
  context_strategy: sliding_window
  context_window: 16000
executors:
  code:
    model: anthropic/claude-sonnet-4-6
    max_tokens: 8000
    tools: []
    context: task_only
providers:
  anthropic:
    api_key_env: ANTHROPIC_API_KEY
routing:
  pre_classifier: true
  classifier_model: classifier
  complexity_threshold: 0.6
budgets:
  daily_limit_usd: -5.0
  per_task_limit_usd: 2.0
  warning_threshold: 0.8
`;
    const tmpPath = path.resolve(__dirname, '../../.tmp-test-neg-budget.yaml');
    writeFileSync(tmpPath, yaml, 'utf-8');

    try {
      const result = loadConfig(tmpPath);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('validation_error');
        expect(result.error.field).toContain('daily_limit_usd');
      }
    } finally {
      unlinkSync(tmpPath);
    }
  });

  it('rejects config with channels.telegram.mode: webhook (schema-level)', () => {
    const yaml = `
orchestrator:
  model: anthropic/claude-sonnet-4-6
  max_planning_tokens: 4000
  context_strategy: sliding_window
  context_window: 16000
executors:
  code:
    model: anthropic/claude-sonnet-4-6
    max_tokens: 8000
    tools: []
    context: task_only
providers:
  anthropic:
    api_key_env: ANTHROPIC_API_KEY
routing:
  pre_classifier: true
  classifier_model: classifier
  complexity_threshold: 0.6
budgets:
  daily_limit_usd: 10.0
  per_task_limit_usd: 2.0
  warning_threshold: 0.8
channels:
  telegram:
    enabled: true
    mode: webhook
    token_env: TELEGRAM_BOT_TOKEN
    webhook_url: https://example.com/webhooks/telegram
`;
    const tmpPath = path.resolve(__dirname, '../../.tmp-test-webhook-mode.yaml');
    writeFileSync(tmpPath, yaml, 'utf-8');

    try {
      const result = loadConfig(tmpPath);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Now caught by Zod schema validation (mode only accepts 'longpoll')
        expect(result.error.code).toBe('validation_error');
        expect(result.error.field).toBe('channels.telegram.mode');
      }
    } finally {
      try { unlinkSync(tmpPath); } catch { /* virtiofs may prevent unlink in test env */ }
    }
  });

  it('warns but does not fail when an env var is not set', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // ANTHROPIC_API_KEY is very likely not set in the test environment
    delete process.env.ANTHROPIC_API_KEY;

    const result = loadConfig(exampleConfigPath);
    expect(result.ok).toBe(true);
    // A warning should have been logged for the missing env var
    if (process.env.ANTHROPIC_API_KEY === undefined) {
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ANTHROPIC_API_KEY'));
    }
  });
});
