import { describe, it, expect, vi } from 'vitest';
import { proposeUpgrades, runSmokeTest, applyUpgrades, formatUpgradeReport } from './upgrade.js';
import { ModelCatalog } from './catalog.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { CatalogData } from './catalog.js';
import type { AlduinConfig } from '../config/types.js';
import type { LLMProvider } from '../types/llm.js';
import { writeFileSync, readFileSync, unlinkSync, existsSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function mockProvider(id: string): LLMProvider & { complete: ReturnType<typeof vi.fn> } {
  return { id, complete: vi.fn(), countTokens: () => 0, estimateCost: () => 0 };
}

const minConfig: AlduinConfig = {
  catalog_version: '2026-04-14',
  orchestrator: {
    model: 'anthropic/claude-sonnet-4-6',
    max_planning_tokens: 4000,
    context_strategy: 'sliding_window',
    context_window: 16000,
  },
  executors: {
    code: { model: 'anthropic/claude-sonnet-4-6', max_tokens: 8000, tools: [], context: 'task_only' },
  },
  providers: { anthropic: {} },
  routing: { pre_classifier: false, classifier_model: 'classifier', complexity_threshold: 0.6 },
  budgets: { daily_limit_usd: 10, per_task_limit_usd: 2, warning_threshold: 0.8 },
};

const catalogData: CatalogData = {
  catalog_version: '2026-04-14',
  models: {
    'anthropic/claude-sonnet-4-6': {
      provider: 'anthropic',
      api_id: 'claude-sonnet-4-6',
      released: '2026-02-10',
      status: 'stable',
      context_window: 200000,
      max_output_tokens: 64000,
      tokenizer: 'anthropic',
      pricing_usd_per_mtok: { input: 3, output: 15 },
      capabilities: ['tool_use'],
      deprecated: false,
      sunset_date: null,
    },
    'anthropic/claude-deprecated': {
      provider: 'anthropic',
      api_id: 'claude-deprecated',
      released: '2024-01-01',
      status: 'deprecated',
      context_window: 100000,
      max_output_tokens: 4096,
      tokenizer: 'anthropic',
      pricing_usd_per_mtok: { input: 8, output: 24 },
      capabilities: [],
      deprecated: true,
      sunset_date: null,
    },
  },
};

describe('upgrade', () => {
  describe('proposeUpgrades', () => {
    it('returns empty array when all models are current', () => {
      const catalog = new ModelCatalog(catalogData);
      const proposals = proposeUpgrades(minConfig, catalog);
      expect(proposals).toHaveLength(0);
    });

    it('proposes upgrade for deprecated models', () => {
      const deprecatedConfig: AlduinConfig = {
        ...minConfig,
        executors: {
          code: { model: 'anthropic/claude-deprecated', max_tokens: 4000, tools: [], context: 'task_only' },
        },
      };
      const catalog = new ModelCatalog(catalogData);
      const proposals = proposeUpgrades(deprecatedConfig, catalog);
      expect(proposals.length).toBeGreaterThan(0);
      expect(proposals[0]!.current_model).toBe('anthropic/claude-deprecated');
    });
  });

  describe('runSmokeTest', () => {
    it('passes when provider returns a successful response', async () => {
      const registry = new ProviderRegistry();
      const provider = mockProvider('anthropic');
      provider.complete.mockResolvedValue({
        ok: true,
        value: {
          content: 'ok',
          usage: { input_tokens: 5, output_tokens: 1 },
          model: 'claude-sonnet-4-6',
          finish_reason: 'stop',
        },
      });
      registry.register('anthropic', provider);

      const result = await runSmokeTest('anthropic/claude-sonnet-4-6', registry);
      expect(result.passed).toBe(true);
    });

    it('fails when provider is not registered', async () => {
      const registry = new ProviderRegistry();
      const result = await runSmokeTest('unknown/model', registry);
      expect(result.passed).toBe(false);
      expect(result.error).toContain('No provider');
    });

    it('fails when provider returns an error', async () => {
      const registry = new ProviderRegistry();
      const provider = mockProvider('anthropic');
      provider.complete.mockResolvedValue({
        ok: false,
        error: { type: 'auth', message: 'Invalid API key', retryable: false },
      });
      registry.register('anthropic', provider);

      const result = await runSmokeTest('anthropic/claude-sonnet-4-6', registry);
      expect(result.passed).toBe(false);
      expect(result.error).toContain('Invalid API key');
    });
  });

  describe('formatUpgradeReport', () => {
    it('reports no upgrades available when proposals are empty', () => {
      const report = formatUpgradeReport([], false);
      expect(report).toContain('No upgrades available');
    });

    it('shows dry-run header for dry-run mode', () => {
      const report = formatUpgradeReport(
        [{
          current_model: 'a/old',
          proposed_model: 'a/new',
          pricing_delta: { input: 1, output: 2 },
          context_window_delta: 50000,
          smoke_test_passed: true,
        }],
        true
      );
      expect(report).toContain('DRY RUN');
    });
  });

  describe('applyUpgrades', () => {
    it('does not write when no proposals pass smoke test', () => {
      const result = applyUpgrades('/tmp/fake.yaml', [
        {
          current_model: 'a/old',
          proposed_model: 'a/new',
          pricing_delta: { input: 0, output: 0 },
          context_window_delta: 0,
          smoke_test_passed: false,
          smoke_test_error: 'Failed',
        },
      ]);
      expect(result.applied).toBe(0);
    });
  });
});
