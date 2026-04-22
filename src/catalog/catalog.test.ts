import { describe, it, expect, vi } from 'vitest';
import { loadCatalog, ModelCatalog } from './catalog.js';
import type { CatalogData } from './catalog.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const catalogPath = path.resolve(__dirname, 'models.catalog.json');

describe('ModelCatalog', () => {
  it('loads the bundled catalog successfully', () => {
    const result = loadCatalog(catalogPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.version).toBe('2026-04-14');
      expect(result.value.listModels().length).toBeGreaterThan(0);
    }
  });

  it('returns error for nonexistent catalog path', () => {
    const result = loadCatalog('/nonexistent/catalog.json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('load_error');
    }
  });

  it('getModel returns ok for a known model', () => {
    const result = loadCatalog(catalogPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const model = result.value.getModel('anthropic/claude-sonnet-4-6');
    expect(model.ok).toBe(true);
    if (model.ok) {
      expect(model.value.provider).toBe('anthropic');
      expect(model.value.tokenizer).toBe('anthropic');
      expect(model.value.pricing_usd_per_mtok.input).toBe(3);
      expect(model.value.pricing_usd_per_mtok.output).toBe(15);
    }
  });

  it('getModel returns not_found for a missing model', () => {
    const result = loadCatalog(catalogPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const model = result.value.getModel('nonexistent/model-v99');
    expect(model.ok).toBe(false);
    if (!model.ok) {
      expect(model.error.code).toBe('not_found');
      expect(model.error.message).toContain('not found in catalog');
    }
  });

  it('getModel returns sunset error for a sunset model', () => {
    const data: CatalogData = {
      catalog_version: '2026-04-14',
      models: {
        'test/sunset-model': {
          provider: 'test',
          api_id: 'sunset-model',
          released: '2024-01-01',
          status: 'deprecated',
          context_window: 4096,
          max_output_tokens: 1024,
          tokenizer: 'cl100k_base',
          pricing_usd_per_mtok: { input: 1, output: 2 },
          capabilities: [],
          deprecated: true,
          sunset_date: '2025-01-01',
        },
      },
    };
    const catalog = new ModelCatalog(data);
    const result = catalog.getModel('test/sunset-model');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('sunset');
      expect(result.error.message).toContain('sunset');
    }
  });

  it('isDeprecated returns true for a deprecated model', () => {
    const data: CatalogData = {
      catalog_version: '2026-04-14',
      models: {
        'test/old-model': {
          provider: 'test',
          api_id: 'old-model',
          released: '2024-01-01',
          status: 'deprecated',
          context_window: 4096,
          max_output_tokens: 1024,
          tokenizer: 'cl100k_base',
          pricing_usd_per_mtok: { input: 1, output: 2 },
          capabilities: [],
          deprecated: true,
          sunset_date: null,
        },
      },
    };
    const catalog = new ModelCatalog(data);
    expect(catalog.isDeprecated('test/old-model')).toBe(true);
    expect(catalog.isDeprecated('nonexistent/model')).toBe(false);
  });

  it('getPricing returns pricing for a known model', () => {
    const result = loadCatalog(catalogPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const pricing = result.value.getPricing('openai/gpt-4.1');
    expect(pricing).not.toBeNull();
    expect(pricing!.input).toBe(2);
    expect(pricing!.output).toBe(8);
  });

  it('getPricing returns null for an unknown model', () => {
    const result = loadCatalog(catalogPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.getPricing('unknown/model')).toBeNull();
  });

  it('getTokenizer returns the correct tokenizer name', () => {
    const result = loadCatalog(catalogPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.getTokenizer('anthropic/claude-sonnet-4-6')).toBe('anthropic');
    expect(result.value.getTokenizer('openai/gpt-4.1')).toBe('cl100k_base');
    expect(result.value.getTokenizer('ollama/qwen2.5-7b')).toBe('cl100k_base');
  });

  it('mergeOverrides adds new models', () => {
    const result = loadCatalog(catalogPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const catalog = result.value;
    expect(catalog.has('custom/my-model')).toBe(false);

    catalog.mergeOverrides({
      models: {
        'custom/my-model': {
          provider: 'custom',
          api_id: 'my-model',
          released: '2026-01-01',
          status: 'stable',
          context_window: 8192,
          max_output_tokens: 2048,
          tokenizer: 'cl100k_base',
          pricing_usd_per_mtok: { input: 0, output: 0 },
          capabilities: [],
          deprecated: false,
          sunset_date: null,
        },
      },
    });

    expect(catalog.has('custom/my-model')).toBe(true);
  });

  it('returns validation error for malformed catalog JSON', async () => {
    const { writeFileSync, unlinkSync } = await import('fs');
    const tmpPath = path.resolve(__dirname, '../../.tmp-bad-catalog.json');
    writeFileSync(tmpPath, '{"catalog_version": "bad", "models": {"x": "not_an_object"}}', 'utf-8');

    try {
      const result = loadCatalog(tmpPath);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('load_error');
      }
    } finally {
      unlinkSync(tmpPath);
    }
  });
});
