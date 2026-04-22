import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadPlugins } from './loader.js';

// ── Test fixtures ───────────────────────────────────────────────────────────

/** Create a temp directory that auto-cleans. */
function makeTempRoot(): string {
  const dir = join(tmpdir(), `alduin-plugin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a alduin.plugin.json manifest into a plugin directory. */
function writeManifest(pluginDir: string, manifest: Record<string, unknown>): void {
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'alduin.plugin.json'), JSON.stringify(manifest, null, 2));
}

/** Write a minimal JS entry module that exports a provider plugin. */
function writeProviderEntry(pluginDir: string, entryRelPath: string, providerId: string): void {
  const entryPath = join(pluginDir, entryRelPath);
  const dir = entryPath.substring(0, entryPath.lastIndexOf('/'));
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    entryPath,
    `
    export const provider = {
      id: '${providerId}',
      async complete() { return { ok: true, value: { content: 'test', usage: { input_tokens: 0, output_tokens: 0 }, model: 'test', finish_reason: 'stop' } }; },
      countTokens() { return 0; },
    };
    `,
  );
}

/** Write a minimal JS entry module that exports a tool plugin. */
function writeToolEntry(pluginDir: string, entryRelPath: string, toolName: string): void {
  const entryPath = join(pluginDir, entryRelPath);
  const dir = entryPath.substring(0, entryPath.lastIndexOf('/'));
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    entryPath,
    `
    export const tool = {
      id: '${toolName}-plugin',
      listTools() { return [{ name: '${toolName}', description: 'Test tool', inputSchema: { type: 'object', properties: {} } }]; },
      async invoke() { return { ok: true, output: 'ok' }; },
    };
    `,
  );
}

/** Write a minimal JS entry that exports an object missing required methods. */
function writeBadEntry(pluginDir: string, entryRelPath: string): void {
  const entryPath = join(pluginDir, entryRelPath);
  const dir = entryPath.substring(0, entryPath.lastIndexOf('/'));
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(entryPath, 'export default { id: "bad" };');
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Plugin loader', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ── Success path ────────────────────────────────────────────────────────

  it('loads a valid builtin provider plugin', async () => {
    const pluginDir = join(root, 'plugins', 'builtin', 'test-provider');
    writeManifest(pluginDir, {
      id: 'test-provider',
      version: '0.1.0',
      kind: 'provider',
      entry: './index.mjs',
      providers: ['test-prov'],
    });
    writeProviderEntry(pluginDir, 'index.mjs', 'test-prov');

    const result = await loadPlugins({ projectRoot: root, currentSchemaSha: null });

    expect(result.errors).toHaveLength(0);
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].manifest.id).toBe('test-provider');
    expect(result.plugins[0].source).toBe('builtin');
    expect(result.plugins[0].exports?.kind).toBe('provider');
  });

  it('loads plugins from local paths', async () => {
    const pluginDir = join(root, 'my-plugins', 'local-tool');
    writeManifest(pluginDir, {
      id: 'local-tool',
      version: '0.1.0',
      kind: 'tool',
      entry: './index.mjs',
      tools: ['my-calc'],
    });
    writeToolEntry(pluginDir, 'index.mjs', 'my-calc');

    const result = await loadPlugins({
      projectRoot: root,
      localPaths: [join(root, 'my-plugins', 'local-tool')],
      currentSchemaSha: null,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].source).toBe('local');
  });

  // ── Error: missing entry file ──────────────────────────────────────────

  it('reports error when entry file is missing', async () => {
    const pluginDir = join(root, 'plugins', 'builtin', 'no-entry');
    writeManifest(pluginDir, {
      id: 'no-entry',
      version: '0.1.0',
      kind: 'provider',
      entry: './dist/index.js',
      providers: ['no-entry'],
    });
    // Deliberately NOT writing the entry file

    const result = await loadPlugins({ projectRoot: root, currentSchemaSha: null });

    expect(result.plugins).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('entry_not_found');
    expect(result.errors[0].pluginId).toBe('no-entry');
    expect(result.errors[0].message).toContain('Entry file not found');
    expect(result.errors[0].message).toContain('Build the plugin first');
  });

  // ── Plugin entry containment (path-traversal guard) ────────────────────

  it('refuses an entry path that escapes the plugin directory via ..', async () => {
    const pluginDir = join(root, 'plugins', 'builtin', 'traversal');
    // Write a file OUTSIDE the plugin directory — if the loader follows the
    // declared entry it would pick this up. The guard must reject it.
    writeFileSync(join(root, 'rogue.mjs'), 'export const provider = {};');

    writeManifest(pluginDir, {
      id: 'traversal',
      version: '0.1.0',
      kind: 'provider',
      entry: '../../../rogue.mjs',
      providers: ['traversal'],
    });

    const result = await loadPlugins({ projectRoot: root, currentSchemaSha: null });

    expect(result.plugins).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('entry_not_found');
    // The error message indicates the file was refused (not loaded).
    expect(result.errors[0].pluginId).toBe('traversal');
  });

  it('refuses an absolute entry path that lands outside the plugin directory', async () => {
    const pluginDir = join(root, 'plugins', 'builtin', 'absolute-escape');
    // Write a target file somewhere else on disk under root, not inside the plugin dir.
    const outsideTarget = join(root, 'outside.mjs');
    writeFileSync(outsideTarget, 'export const provider = {};');

    writeManifest(pluginDir, {
      id: 'absolute-escape',
      version: '0.1.0',
      kind: 'provider',
      entry: outsideTarget, // absolute path outside pluginDir
      providers: ['absolute-escape'],
    });

    const result = await loadPlugins({ projectRoot: root, currentSchemaSha: null });

    expect(result.plugins).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('entry_not_found');
  });

  // ── Error: bad schema (invalid manifest) ───────────────────────────────

  it('reports error when manifest has invalid schema', async () => {
    const pluginDir = join(root, 'plugins', 'builtin', 'bad-schema');
    writeManifest(pluginDir, {
      id: 'INVALID ID WITH SPACES',   // violates the regex
      version: 'not-semver',
      kind: 'provider',
      // missing required 'entry' and 'providers'
    });

    const result = await loadPlugins({ projectRoot: root, currentSchemaSha: null });

    expect(result.plugins).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('manifest_invalid');
    expect(result.errors[0].message).toContain('Invalid manifest');
    expect(result.errors[0].message).toContain('@alduin/plugin-sdk');
  });

  it('reports error when manifest JSON is malformed', async () => {
    const pluginDir = join(root, 'plugins', 'builtin', 'bad-json');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'alduin.plugin.json'), '{ not valid json }}}');

    const result = await loadPlugins({ projectRoot: root, currentSchemaSha: null });

    expect(result.plugins).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('manifest_invalid');
  });

  it('reports error when manifest file is missing entirely', async () => {
    const pluginDir = join(root, 'plugins', 'builtin', 'no-manifest');
    mkdirSync(pluginDir, { recursive: true });
    // No alduin.plugin.json at all

    const result = await loadPlugins({ projectRoot: root, currentSchemaSha: null });

    expect(result.plugins).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('manifest_not_found');
    expect(result.errors[0].message).toContain('Missing alduin.plugin.json');
  });

  // ── Error: conflicting provider ID ─────────────────────────────────────

  it('reports error when two plugins claim the same provider ID', async () => {
    // Plugin A
    const pluginA = join(root, 'plugins', 'builtin', 'prov-a');
    writeManifest(pluginA, {
      id: 'prov-a',
      version: '0.1.0',
      kind: 'provider',
      entry: './index.mjs',
      providers: ['shared-provider'],
    });
    writeProviderEntry(pluginA, 'index.mjs', 'shared-provider');

    // Plugin B — claims the same provider ID
    const pluginB = join(root, 'plugins', 'builtin', 'prov-b');
    writeManifest(pluginB, {
      id: 'prov-b',
      version: '0.1.0',
      kind: 'provider',
      entry: './index.mjs',
      providers: ['shared-provider'],
    });
    writeProviderEntry(pluginB, 'index.mjs', 'shared-provider');

    const result = await loadPlugins({ projectRoot: root, currentSchemaSha: null });

    // One loads, the other is rejected
    expect(result.plugins).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('provider_conflict');
    expect(result.errors[0].message).toContain('shared-provider');
    expect(result.errors[0].message).toContain('already registered');
  });

  // ── Error: entry module fails to load ──────────────────────────────────

  it('reports error when entry module exports wrong shape', async () => {
    const pluginDir = join(root, 'plugins', 'builtin', 'bad-export');
    writeManifest(pluginDir, {
      id: 'bad-export',
      version: '0.1.0',
      kind: 'provider',
      entry: './index.mjs',
      providers: ['bad-export'],
    });
    writeBadEntry(pluginDir, 'index.mjs');

    const result = await loadPlugins({ projectRoot: root, currentSchemaSha: null });

    expect(result.plugins).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('entry_load_failed');
    expect(result.errors[0].message).toContain('complete() method');
  });

  // ── Empty state ────────────────────────────────────────────────────────

  it('returns empty results when no plugins directory exists', async () => {
    const result = await loadPlugins({ projectRoot: root, currentSchemaSha: null });

    expect(result.plugins).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  // ── Multiple plugins ──────────────────────────────────────────────────

  it('loads multiple plugins from different sources', async () => {
    // Builtin provider
    const builtinDir = join(root, 'plugins', 'builtin', 'my-provider');
    writeManifest(builtinDir, {
      id: 'my-provider',
      version: '0.1.0',
      kind: 'provider',
      entry: './index.mjs',
      providers: ['my-prov'],
    });
    writeProviderEntry(builtinDir, 'index.mjs', 'my-prov');

    // Local tool
    const localDir = join(root, 'extras', 'my-tool');
    writeManifest(localDir, {
      id: 'my-tool',
      version: '0.1.0',
      kind: 'tool',
      entry: './index.mjs',
      tools: ['calc'],
    });
    writeToolEntry(localDir, 'index.mjs', 'calc');

    const result = await loadPlugins({
      projectRoot: root,
      localPaths: [localDir],
      currentSchemaSha: null,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.plugins).toHaveLength(2);

    const ids = result.plugins.map((p) => p.manifest.id).sort();
    expect(ids).toEqual(['my-provider', 'my-tool']);
  });
});
