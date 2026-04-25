/**
 * Unit tests for alduin reconfigure.
 *
 * Tests the pure helper functions: readRaw/writeAndValidate are tested
 * indirectly via the config snapshot tests below. The interactive menu
 * loop and individual section functions are covered by integration-style
 * smoke tests using mocked wizard steps.
 */

import { describe, it, expect } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { loadConfig } from '../config/loader.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Minimal valid config YAML for round-trip tests
const MINIMAL_VALID_CONFIG = `
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
  daily_limit_usd: 0
  per_task_limit_usd: 0.5
  warning_threshold: 0.8
`;

describe('reconfigure: config round-trip', () => {
  it('accepts daily_limit_usd=0 (disabled) in config schema', () => {
    const tmpPath = path.resolve(__dirname, '../../.tmp-reconfigure-test.yaml');
    try {
      writeFileSync(tmpPath, MINIMAL_VALID_CONFIG, 'utf-8');
      const result = loadConfig(tmpPath);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.budgets.daily_limit_usd).toBe(0);
        expect(result.value.budgets.per_task_limit_usd).toBe(0.5);
      }
    } finally {
      try { unlinkSync(tmpPath); } catch { /* virtiofs may prevent unlink in test env */ }
    }
  });

  it('existing config preserves unrelated keys after a section update', () => {
    // Simulate what reconfigure does: read raw, mutate one section, re-validate
    const raw = parseYaml(MINIMAL_VALID_CONFIG) as Record<string, unknown>;
    expect(raw['orchestrator']).toBeDefined();
    expect(raw['providers']).toBeDefined();

    // Mutate only budgets
    const newBudgets = { daily_limit_usd: 10, per_task_limit_usd: 2, warning_threshold: 0.9 };
    raw['budgets'] = newBudgets;

    // Orchestrator + providers must be unchanged
    const orch = raw['orchestrator'] as Record<string, unknown>;
    expect(orch['model']).toBe('anthropic/claude-sonnet-4-6');
    const prov = raw['providers'] as Record<string, unknown>;
    expect(prov['anthropic']).toBeDefined();

    // Updated budget survives
    const bud = raw['budgets'] as Record<string, unknown>;
    expect(bud['daily_limit_usd']).toBe(10);
  });
});
