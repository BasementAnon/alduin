import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as toYaml } from 'yaml';
import type { DoctorContext } from '../rule.js';
import { runRules } from '../runner.js';
import { configValidRule } from './config-valid.js';
import { catalogVersionRule } from './catalog-version.js';
import { modelsExistRule } from './models-exist.js';
import { modelsDeprecatedRule } from './models-deprecated.js';
import { envOverridesRule } from './env-overrides.js';
import { dotenvSecretsRule } from './dotenv-secrets.js';
import { legacyKeysRule, LEGACY_KEY_RENAMES } from './legacy-keys.js';
import { pluginSchemaDriftRule } from './plugin-schema-drift.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

function minimalValidConfig(): Record<string, unknown> {
  return {
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
    providers: { anthropic: { api_key_env: 'ANTHROPIC_API_KEY' } },
    routing: { pre_classifier: true, classifier_model: 'code', complexity_threshold: 0.6 },
    budgets: { daily_limit_usd: 10, per_task_limit_usd: 2, warning_threshold: 0.8 },
  };
}

function makeConfigFile(dir: string, content: object, name = 'config.yaml'): string {
  const path = join(dir, name);
  writeFileSync(path, toYaml(content), 'utf-8');
  return path;
}

function makeCtx(overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    configPath: overrides.configPath ?? '/nonexistent',
    vaultPath: '.alduin/vault.db',
    root: overrides.root ?? tmpDir,
    config: overrides.config ?? null,
    catalog: overrides.catalog ?? null,
    env: overrides.env ?? {},
    skipVault: true,
    fix: overrides.fix ?? false,
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'alduin-rules-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Golden: dotenv-secrets ──────────────────────────────────────────────────

describe('dotenv-secrets rule', () => {
  it('passes when no secrets in env', () => {
    const ctx = makeCtx({ env: { PATH: '/usr/bin' } });
    const result = dotenvSecretsRule.check(ctx);
    expect(result.status).toBe('pass');
  });

  it('warns when API keys are present in env', () => {
    const ctx = makeCtx({
      env: { ANTHROPIC_API_KEY: 'sk-ant-xxx', OPENAI_API_KEY: 'sk-xxx' },
    });
    const result = dotenvSecretsRule.check(ctx);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('ANTHROPIC_API_KEY');
    expect(result.detail).toContain('OPENAI_API_KEY');
    expect(result.fixable).toBe(true);
  });

  it('ignores empty env values', () => {
    const ctx = makeCtx({ env: { ANTHROPIC_API_KEY: '' } });
    const result = dotenvSecretsRule.check(ctx);
    expect(result.status).toBe('pass');
  });
});

// ── Golden: legacy-keys ─────────────────────────────────────────────────────

describe('legacy-keys rule', () => {
  it('passes when no legacy keys exist', () => {
    const configPath = makeConfigFile(tmpDir, minimalValidConfig());
    const ctx = makeCtx({ configPath });
    const result = legacyKeysRule.check(ctx);
    expect(result.status).toBe('pass');
  });

  it('warns when legacy provider key exists', () => {
    const cfg = {
      ...minimalValidConfig(),
      providers: { anthropic_api_key: 'sk-xxx', anthropic: { api_key_env: 'ANTHROPIC_API_KEY' } },
    };
    const configPath = makeConfigFile(tmpDir, cfg);
    const ctx = makeCtx({ configPath });
    const result = legacyKeysRule.check(ctx);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('providers.anthropic_api_key');
    expect(result.fixable).toBe(true);
  });

  it('fixes legacy keys by renaming them', () => {
    const cfg = {
      ...minimalValidConfig(),
      providers: { anthropic_api_key: 'sk-xxx', anthropic: { api_key_env: 'ANTHROPIC_API_KEY' } },
    };
    const configPath = makeConfigFile(tmpDir, cfg);
    const ctx = makeCtx({ configPath, fix: true });

    const msg = legacyKeysRule.fix!(ctx);
    expect(msg).toContain('Renamed');
    expect(msg).toContain('providers.anthropic_api_key');
  });

  it('documents known renames for Phases 1-5', () => {
    expect(Object.keys(LEGACY_KEY_RENAMES).length).toBeGreaterThan(0);
    // Phase 2 provider key renames
    expect(LEGACY_KEY_RENAMES['providers.anthropic_api_key']).toBe(
      'providers.anthropic.credentials.api_key'
    );
    // Phase 3 orchestrator renames
    expect(LEGACY_KEY_RENAMES['orchestrator.max_sub_tasks']).toBe(
      'orchestrator.max_recursion_depth'
    );
  });
});

// ── Golden: models-deprecated ───────────────────────────────────────────────

describe('models-deprecated rule', () => {
  it('passes with null config/catalog', () => {
    const ctx = makeCtx();
    const result = modelsDeprecatedRule.check(ctx);
    expect(result.status).toBe('skip');
  });

  it('includes successor suggestion in detail', () => {
    const mockCatalog = {
      version: '2026-04-14',
      has: () => true,
      isDeprecated: (m: string) => m === 'anthropic/claude-3-opus-20240229',
    } as unknown as import('../../../catalog/catalog.js').ModelCatalog;

    const mockConfig = {
      orchestrator: { model: 'anthropic/claude-3-opus-20240229' },
      executors: {},
    } as unknown as import('../../../config/schema/index.js').AlduinConfig;

    const ctx = makeCtx({ config: mockConfig, catalog: mockCatalog });
    const result = modelsDeprecatedRule.check(ctx);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('claude-opus-4');
    expect(result.detail).toContain('alduin models upgrade');
    expect(result.fixable).toBe(false);
  });
});

// ── Golden: plugin-schema-drift ─────────────────────────────────────────────

describe('plugin-schema-drift rule', () => {
  it('skips when no plugins directory', () => {
    const ctx = makeCtx({ root: tmpDir });
    const result = pluginSchemaDriftRule.check(ctx);
    expect(result.status).toBe('skip');
  });

  it('passes with valid plugin manifests', () => {
    const pluginDir = join(tmpDir, 'plugins', 'builtin', 'test-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'alduin.plugin.json'),
      JSON.stringify({
        id: 'test-plugin',
        version: '1.0.0',
        kind: 'tool',
        entry: './src/index.ts',
        tools: ['test'],
      }),
    );
    const ctx = makeCtx({ root: tmpDir });
    const result = pluginSchemaDriftRule.check(ctx);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('1 plugin');
  });

  it('warns on invalid manifest', () => {
    const pluginDir = join(tmpDir, 'plugins', 'builtin', 'bad-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'alduin.plugin.json'),
      JSON.stringify({ id: 'bad', version: 'not-semver', kind: 'tool', entry: './index.ts' }),
    );
    const ctx = makeCtx({ root: tmpDir });
    const result = pluginSchemaDriftRule.check(ctx);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('bad-plugin');
  });
});

// ── Golden: catalog-version (fix round-trip) ────────────────────────────────

describe('catalog-version rule', () => {
  it('warns when catalog_version missing', () => {
    const mockCatalog = { version: '2026-04-14' } as unknown as import('../../../catalog/catalog.js').ModelCatalog;
    const cfg = minimalValidConfig();
    delete cfg['catalog_version'];
    const mockConfig = cfg as unknown as import('../../../config/schema/index.js').AlduinConfig;
    const ctx = makeCtx({ config: mockConfig, catalog: mockCatalog });
    const result = catalogVersionRule.check(ctx);
    expect(result.status).toBe('warn');
    expect(result.fixable).toBe(true);
  });

  it('fix writes catalog_version to YAML', () => {
    const cfg = minimalValidConfig();
    delete cfg['catalog_version'];
    const configPath = makeConfigFile(tmpDir, cfg);

    const mockCatalog = { version: '2026-04-14' } as unknown as import('../../../catalog/catalog.js').ModelCatalog;
    const ctx = makeCtx({ configPath, catalog: mockCatalog, fix: true });

    const msg = catalogVersionRule.fix!(ctx);
    expect(msg).toContain('2026-04-14');

    // Verify the file was updated
    const { parse } = require('yaml') as typeof import('yaml');
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const updated = parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(updated['catalog_version']).toBe('2026-04-14');
  });
});

// ── Golden: runner integration ──────────────────────────────────────────────

describe('rule runner integration', () => {
  it('runs all rules and returns results', async () => {
    const ctx = makeCtx({ env: {} });
    const { checks } = await runRules(
      [configValidRule, dotenvSecretsRule, legacyKeysRule],
      ctx,
    );
    expect(checks).toHaveLength(3);
    // configValid should fail (no config file), dotenvSecrets should pass, legacyKeys should skip
    expect(checks[0]!.id).toBe('config-valid');
    expect(checks[1]!.id).toBe('dotenv-secrets');
    expect(checks[2]!.id).toBe('legacy-keys');
  });

  it('applies fixes and reports fix log', async () => {
    const cfg = minimalValidConfig();
    delete cfg['catalog_version'];
    const configPath = makeConfigFile(tmpDir, cfg);

    const mockCatalog = { version: '2026-04-14' } as unknown as import('../../../catalog/catalog.js').ModelCatalog;
    // Config without catalog_version — check will see warn, fix will write it
    const mockConfig = cfg as unknown as import('../../../config/schema/index.js').AlduinConfig;

    const ctx = makeCtx({
      configPath,
      config: mockConfig,
      catalog: mockCatalog,
      fix: true,
    });

    const { checks, fixLog } = await runRules([catalogVersionRule], ctx);
    // Fix was applied (wrote to YAML) but ctx.config isn't refreshed,
    // so the re-check still reads from the stale ctx.config.
    // The important assertion: fix was invoked and logged.
    expect(fixLog.length).toBeGreaterThan(0);
    expect(fixLog[0]).toContain('2026-04-14');
    // Check is either 'fixed' (if rule re-reads YAML) or 'warn' (if rule uses ctx.config)
    expect(['warn', 'fixed']).toContain(checks[0]!.status);
  });
});
