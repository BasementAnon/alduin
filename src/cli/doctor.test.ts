import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as toYaml } from 'yaml';
import { formatDoctorTable, runDoctorChecks } from './doctor.js';
import type { DoctorCheck } from './doctor.js';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function minimalValidConfig(): object {
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
      classifier: { model: 'ollama/qwen2.5-7b', max_tokens: 200, tools: [], context: 'message_only' },
    },
    providers: { anthropic: { api_key_env: 'ANTHROPIC_API_KEY' } },
    routing: { pre_classifier: true, classifier_model: 'classifier', complexity_threshold: 0.6 },
    budgets: { daily_limit_usd: 10, per_task_limit_usd: 2, warning_threshold: 0.8 },
  };
}

function makeConfigFile(dir: string, content: object, name = 'config.yaml'): string {
  const path = join(dir, name);
  writeFileSync(path, toYaml(content), 'utf-8');
  return path;
}

// ── Test setup ────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'alduin-doctor-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Golden: good config ───────────────────────────────────────────────────────

describe('runDoctorChecks — good config', () => {
  it('passes config-valid', async () => {
    const configPath = makeConfigFile(tmpDir, minimalValidConfig());
    const checks = await runDoctorChecks({ configPath, skipVault: true });
    const c = checks.find((ch) => ch.id === 'config-valid');
    expect(c?.status).toBe('pass');
  });

  it('passes catalog-version', async () => {
    const configPath = makeConfigFile(tmpDir, minimalValidConfig());
    const checks = await runDoctorChecks({ configPath, skipVault: true });
    const c = checks.find((ch) => ch.id === 'catalog-version');
    // Depends on the bundled catalog version — either pass or warn
    expect(['pass', 'warn']).toContain(c?.status);
  });

  it('passes models-exist for known catalog models', async () => {
    const configPath = makeConfigFile(tmpDir, minimalValidConfig());
    const checks = await runDoctorChecks({ configPath, skipVault: true });
    const c = checks.find((ch) => ch.id === 'models-exist');
    expect(c?.status).toBe('pass');
  });

  it('passes models-not-deprecated for non-deprecated models', async () => {
    const configPath = makeConfigFile(tmpDir, minimalValidConfig());
    const checks = await runDoctorChecks({ configPath, skipVault: true });
    const c = checks.find((ch) => ch.id === 'models-not-deprecated');
    expect(c?.status).toBe('pass');
  });

  it('passes env-overrides-parse with no ALDUIN_ vars', async () => {
    const configPath = makeConfigFile(tmpDir, minimalValidConfig());
    const checks = await runDoctorChecks({
      configPath, skipVault: true,
      env: { PATH: '/usr/bin' }, // no ALDUIN_ vars
    });
    const c = checks.find((ch) => ch.id === 'env-overrides-parse');
    expect(c?.status).toBe('pass');
  });

  it('skips vault checks when skipVault=true', async () => {
    const configPath = makeConfigFile(tmpDir, minimalValidConfig());
    const checks = await runDoctorChecks({ configPath, skipVault: true });
    expect(checks.find((c) => c.id === 'vault-encrypt')?.status).toBe('skip');
    expect(checks.find((c) => c.id === 'no-dangling-refs')?.status).toBe('skip');
  });

  it('renders a table with all rows', async () => {
    const configPath = makeConfigFile(tmpDir, minimalValidConfig());
    const checks = await runDoctorChecks({ configPath, skipVault: true });
    const output = formatDoctorTable(checks, configPath);
    expect(output).toContain('Alduin Doctor');
    expect(output).toContain('Schema validation');
    expect(output).toContain('✓ pass');
    expect(output).toContain('○ skip');
  });
});

// ── Golden: breakage 1 — schema validation fails ──────────────────────────────

describe('runDoctorChecks — breakage: invalid schema', () => {
  it('fails config-valid when a required field is missing', async () => {
    const broken = { ...minimalValidConfig() } as Record<string, unknown>;
    delete broken['orchestrator'];
    const configPath = makeConfigFile(tmpDir, broken);
    const checks = await runDoctorChecks({ configPath, skipVault: true });
    const c = checks.find((ch) => ch.id === 'config-valid');
    expect(c?.status).toBe('fail');
    expect(c?.detail).toMatch(/orchestrator/i);
  });

  it('downstream checks skip when config fails to load', async () => {
    const broken = { ...minimalValidConfig() } as Record<string, unknown>;
    delete broken['orchestrator'];
    const configPath = makeConfigFile(tmpDir, broken);
    const checks = await runDoctorChecks({ configPath, skipVault: true });
    // models-exist and models-not-deprecated depend on a valid config
    const modelsExist = checks.find((c) => c.id === 'models-exist');
    expect(modelsExist?.status).toBe('skip');
  });
});

// ── Golden: breakage 2 — catalog version mismatch ────────────────────────────

describe('runDoctorChecks — breakage: catalog-version mismatch', () => {
  it('warns when catalog_version does not match loaded catalog', async () => {
    const cfg = { ...minimalValidConfig(), catalog_version: '1999-01-01' } as Record<string, unknown>;
    const configPath = makeConfigFile(tmpDir, cfg);
    const checks = await runDoctorChecks({ configPath, skipVault: true });
    const c = checks.find((ch) => ch.id === 'catalog-version');
    expect(c?.status).toBe('warn');
    expect(c?.detail).toContain('1999-01-01');
    expect(c?.fixable).toBe(true);
  });

  it('warns when catalog_version is missing', async () => {
    const cfg = { ...minimalValidConfig() } as Record<string, unknown>;
    delete cfg['catalog_version'];
    const configPath = makeConfigFile(tmpDir, cfg);
    const checks = await runDoctorChecks({ configPath, skipVault: true });
    const c = checks.find((ch) => ch.id === 'catalog-version');
    expect(c?.status).toBe('warn');
    expect(c?.fixable).toBe(true);
  });

  it('fixes catalog_version with --fix', async () => {
    const cfg = { catalog_version: '1999-01-01', ...minimalValidConfig() } as Record<string, unknown>;
    cfg['catalog_version'] = '1999-01-01';
    const configPath = makeConfigFile(tmpDir, cfg);

    const checks = await runDoctorChecks({ configPath, skipVault: true, fix: true });
    const c = checks.find((ch) => ch.id === 'catalog-version');
    // After fix, should be 'pass' or 'fixed'
    expect(['pass', 'fixed']).toContain(c?.status);
  });
});

// ── Golden: breakage 3 — bad ALDUIN_ env var ─────────────────────────────────

describe('runDoctorChecks — breakage: bad ALDUIN_ env var', () => {
  it('fails env-overrides-parse for unknown path', async () => {
    const configPath = makeConfigFile(tmpDir, minimalValidConfig());
    const checks = await runDoctorChecks({
      configPath,
      skipVault: true,
      env: { ALDUIN_ORCHESTRATOR__BOGUS_FIELD: 'value' },
    });
    const c = checks.find((ch) => ch.id === 'env-overrides-parse');
    expect(c?.status).toBe('fail');
    expect(c?.detail).toMatch(/BOGUS_FIELD|unknown/i);
  });

  it('passes env-overrides-parse for a valid override', async () => {
    const configPath = makeConfigFile(tmpDir, minimalValidConfig());
    const checks = await runDoctorChecks({
      configPath,
      skipVault: true,
      env: { ALDUIN_BUDGETS__DAILY_LIMIT_USD: '20' },
    });
    const c = checks.find((ch) => ch.id === 'env-overrides-parse');
    expect(c?.status).toBe('pass');
    expect(c?.detail).toContain('1 override');
  });
});

// ── formatDoctorTable snapshot ────────────────────────────────────────────────

describe('formatDoctorTable', () => {
  it('matches snapshot for a fully-passing result set', () => {
    const checks: DoctorCheck[] = [
      { id: 'config-valid', label: 'Schema validation', status: 'pass', detail: '', fixable: false },
      { id: 'catalog-version', label: 'Catalog version', status: 'pass', detail: '2026-04-14', fixable: false },
      { id: 'models-exist', label: 'Model pins exist in catalog', status: 'pass', detail: '2 pins OK', fixable: false },
      { id: 'models-not-deprecated', label: 'No deprecated model pins', status: 'pass', detail: '', fixable: false },
      { id: 'env-overrides-parse', label: 'ALDUIN_* env overrides parse', status: 'pass', detail: '', fixable: false },
      { id: 'schema-in-sync', label: 'Generated schema up to date', status: 'pass', detail: 'SHA abc123', fixable: false },
      { id: 'vault-encrypt', label: 'Vault encrypt/decrypt round-trip', status: 'skip', detail: 'Vault check skipped', fixable: false },
      { id: 'no-dangling-refs', label: 'No unresolved SecretRefs', status: 'skip', detail: 'Vault check skipped', fixable: false },
    ];
    const output = formatDoctorTable(checks, 'config.yaml');
    expect(output).toMatchSnapshot();
  });

  it('matches snapshot for a result set with failures', () => {
    const checks: DoctorCheck[] = [
      { id: 'config-valid', label: 'Schema validation', status: 'pass', detail: '', fixable: false },
      { id: 'catalog-version', label: 'Catalog version', status: 'warn', detail: 'Config pins 1999-01-01, catalog is 2026-04-14', fixable: true },
      { id: 'models-exist', label: 'Model pins exist in catalog', status: 'fail', detail: 'Unknown: fake/model-x', fixable: false },
      { id: 'models-not-deprecated', label: 'No deprecated model pins', status: 'pass', detail: '', fixable: false },
      { id: 'env-overrides-parse', label: 'ALDUIN_* env overrides parse', status: 'fail', detail: 'env-override: unknown config path "orchestrator.bogus"', fixable: false },
      { id: 'schema-in-sync', label: 'Generated schema up to date', status: 'warn', detail: 'Committed SHA abc ≠ fresh xyz', fixable: true },
      { id: 'vault-encrypt', label: 'Vault encrypt/decrypt round-trip', status: 'skip', detail: 'Vault check skipped', fixable: false },
      { id: 'no-dangling-refs', label: 'No unresolved SecretRefs', status: 'skip', detail: 'Vault check skipped', fixable: false },
    ];
    const output = formatDoctorTable(checks, 'config.broken.yaml');
    expect(output).toMatchSnapshot();
  });

  it('matches snapshot for a result set after --fix', () => {
    const checks: DoctorCheck[] = [
      { id: 'config-valid', label: 'Schema validation', status: 'pass', detail: '', fixable: false },
      { id: 'catalog-version', label: 'Catalog version', status: 'fixed', detail: 'Fixed: 2026-04-14', fixable: false },
      { id: 'models-exist', label: 'Model pins exist in catalog', status: 'pass', detail: '2 pins OK', fixable: false },
      { id: 'models-not-deprecated', label: 'No deprecated model pins', status: 'pass', detail: '', fixable: false },
      { id: 'env-overrides-parse', label: 'ALDUIN_* env overrides parse', status: 'pass', detail: '', fixable: false },
      { id: 'schema-in-sync', label: 'Generated schema up to date', status: 'fixed', detail: 'Fixed: SHA 076c8ad9a5414c22', fixable: false },
      { id: 'vault-encrypt', label: 'Vault encrypt/decrypt round-trip', status: 'skip', detail: 'Vault check skipped', fixable: false },
      { id: 'no-dangling-refs', label: 'No unresolved SecretRefs', status: 'skip', detail: 'Vault check skipped', fixable: false },
    ];
    const output = formatDoctorTable(checks, 'config.yaml');
    expect(output).toMatchSnapshot();
  });
});

// ── config command unit tests ─────────────────────────────────────────────────

describe('configGet / configSet / configUnset (via path-utils)', () => {
  it('path-utils getDeep returns the correct nested value', async () => {
    const { getDeep } = await import('../config/path-utils.js');
    const obj = { a: { b: { c: 42 } } };
    expect(getDeep(obj, ['a', 'b', 'c'])).toBe(42);
    expect(getDeep(obj, ['a', 'b'])).toEqual({ c: 42 });
    expect(getDeep(obj, ['x'])).toBeUndefined();
  });

  it('path-utils setDeep creates intermediate objects', async () => {
    const { setDeep } = await import('../config/path-utils.js');
    const obj: Record<string, unknown> = {};
    setDeep(obj, ['a', 'b', 'c'], 99);
    expect((obj['a'] as Record<string, unknown>)['b']).toEqual({ c: 99 });
  });

  it('path-utils deleteDeep removes a key and returns true', async () => {
    const { deleteDeep } = await import('../config/path-utils.js');
    const obj = { a: { b: 1 } };
    const result = deleteDeep(obj, ['a', 'b']);
    expect(result).toBe(true);
    expect((obj['a'] as Record<string, unknown>)['b']).toBeUndefined();
  });

  it('path-utils deleteDeep returns false for nonexistent key', async () => {
    const { deleteDeep } = await import('../config/path-utils.js');
    expect(deleteDeep({}, ['nope'])).toBe(false);
  });

  it('validatePath rejects unknown segments', async () => {
    const { validatePath } = await import('../config/path-utils.js');
    expect(() => validatePath(['orchestrator', 'bogus'])).toThrow(/unknown config path/);
  });

  it('validatePath accepts known paths', async () => {
    const { validatePath } = await import('../config/path-utils.js');
    expect(() => validatePath(['orchestrator', 'model'])).not.toThrow();
    expect(() => validatePath(['budgets', 'daily_limit_usd'])).not.toThrow();
    expect(() => validatePath(['providers', 'anthropic', 'api_key_env'])).not.toThrow();
  });
});
