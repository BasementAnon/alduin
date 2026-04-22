import { describe, it, expect, beforeEach } from 'vitest';

import { PluginRegistry } from './registry.js';
import type { LoadedPlugin, PluginExports } from './types.js';
import type { ProviderPlugin, SkillPlugin, ToolPlugin } from '@alduin/plugin-sdk';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeProviderPlugin(id: string): ProviderPlugin {
  return {
    id,
    async complete() {
      return {
        ok: true as const,
        value: {
          content: 'test',
          usage: { input_tokens: 0, output_tokens: 0 },
          model: 'test',
          finish_reason: 'stop' as const,
        },
      };
    },
    countTokens() { return 0; },
  };
}

function makeSkillPlugin(id: string): SkillPlugin {
  return {
    id,
    getManifestEntries() {
      return [{
        id,
        description: `${id} skill`,
        inputs: ['text'],
        model_hints: { prefer: ['anthropic/claude-sonnet-4-6'] },
      }];
    },
    getDefinition(skillId) {
      if (skillId !== id) return null;
      return {
        id,
        description: `${id} skill`,
        inputs: ['text'],
        model_hints: { prefer: ['anthropic/claude-sonnet-4-6'] },
        prompt: 'You are a test skill.',
        env_required: [],
        os: 'any',
        allow_sub_orchestration: false,
      };
    },
  };
}

function makeToolPlugin(id: string, toolNames: string[]): ToolPlugin {
  return {
    id,
    listTools() {
      return toolNames.map((name) => ({
        name,
        description: `${name} tool`,
        inputSchema: { type: 'object' as const, properties: {} },
      }));
    },
    async invoke(_name, _args) {
      return { ok: true, output: 'done' };
    },
  };
}

function makeLoadedPlugin(
  manifest: LoadedPlugin['manifest'],
  exports: PluginExports | null,
): LoadedPlugin {
  return {
    manifest,
    rootDir: '/fake/path',
    entryPath: '/fake/path/index.js',
    exports,
    source: 'builtin',
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('PluginRegistry', () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  it('starts empty', () => {
    expect(registry.size).toBe(0);
    expect(registry.listPlugins()).toEqual([]);
    expect(registry.listProviderIds()).toEqual([]);
    expect(registry.listSkills()).toEqual([]);
    expect(registry.listTools()).toEqual([]);
  });

  describe('provider plugins', () => {
    it('registers and retrieves a provider by provider ID', () => {
      const plugin = makeProviderPlugin('openrouter');
      registry.register(makeLoadedPlugin(
        { id: 'openrouter', version: '0.1.0', kind: 'provider', entry: './index.js', providers: ['openrouter'] },
        { kind: 'provider', plugin },
      ));

      expect(registry.getProvider('openrouter')).toBe(plugin);
      expect(registry.hasProvider('openrouter')).toBe(true);
      expect(registry.listProviderIds()).toEqual(['openrouter']);
    });

    it('registers multiple provider IDs from one plugin', () => {
      const plugin = makeProviderPlugin('multi');
      registry.register(makeLoadedPlugin(
        { id: 'multi', version: '0.1.0', kind: 'provider', entry: './index.js', providers: ['openai', 'azure-openai'] },
        { kind: 'provider', plugin },
      ));

      expect(registry.getProvider('openai')).toBe(plugin);
      expect(registry.getProvider('azure-openai')).toBe(plugin);
      expect(registry.listProviderIds()).toEqual(['openai', 'azure-openai']);
    });

    it('returns undefined for unknown provider', () => {
      expect(registry.getProvider('nonexistent')).toBeUndefined();
      expect(registry.hasProvider('nonexistent')).toBe(false);
    });
  });

  describe('skill plugins', () => {
    it('registers and lists skills', () => {
      const plugin = makeSkillPlugin('code-review');
      registry.register(makeLoadedPlugin(
        { id: 'code-review', version: '0.1.0', kind: 'skill', entry: './index.js', skills: ['code-review'] },
        { kind: 'skill', plugin },
      ));

      const skills = registry.listSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe('code-review');
      expect(skills[0].description).toBe('code-review skill');
    });

    it('retrieves skill by plugin ID', () => {
      const plugin = makeSkillPlugin('summarize');
      registry.register(makeLoadedPlugin(
        { id: 'summarize', version: '0.1.0', kind: 'skill', entry: './index.js', skills: ['summarize'] },
        { kind: 'skill', plugin },
      ));

      expect(registry.getSkill('summarize')).toBe(plugin);
    });
  });

  describe('tool plugins', () => {
    it('registers and lists tools', () => {
      const plugin = makeToolPlugin('calculator', ['add', 'multiply']);
      registry.register(makeLoadedPlugin(
        { id: 'calculator', version: '0.1.0', kind: 'tool', entry: './index.js', tools: ['add', 'multiply'] },
        { kind: 'tool', plugin },
      ));

      const tools = registry.listTools();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name).sort()).toEqual(['add', 'multiply']);
    });

    it('finds the tool owner by tool name', () => {
      const plugin = makeToolPlugin('web', ['web-search']);
      registry.register(makeLoadedPlugin(
        { id: 'web', version: '0.1.0', kind: 'tool', entry: './index.js', tools: ['web-search'] },
        { kind: 'tool', plugin },
      ));

      expect(registry.getToolOwner('web-search')).toBe(plugin);
      expect(registry.getToolOwner('nonexistent')).toBeUndefined();
    });
  });

  describe('general queries', () => {
    it('lists all plugins across all kinds', () => {
      registry.register(makeLoadedPlugin(
        { id: 'prov', version: '0.1.0', kind: 'provider', entry: './index.js', providers: ['prov'] },
        { kind: 'provider', plugin: makeProviderPlugin('prov') },
      ));
      registry.register(makeLoadedPlugin(
        { id: 'sk', version: '0.1.0', kind: 'skill', entry: './index.js', skills: ['sk'] },
        { kind: 'skill', plugin: makeSkillPlugin('sk') },
      ));
      registry.register(makeLoadedPlugin(
        { id: 'tl', version: '0.1.0', kind: 'tool', entry: './index.js', tools: ['tl'] },
        { kind: 'tool', plugin: makeToolPlugin('tl', ['tl']) },
      ));

      expect(registry.size).toBe(3);
      expect(registry.listPlugins().sort()).toEqual(['prov', 'sk', 'tl']);
    });

    it('retrieves plugin entry by ID', () => {
      registry.register(makeLoadedPlugin(
        { id: 'my-plugin', version: '1.0.0', kind: 'provider', entry: './index.js', providers: ['mp'] },
        { kind: 'provider', plugin: makeProviderPlugin('mp') },
      ));

      const entry = registry.getPluginEntry('my-plugin');
      expect(entry).toBeDefined();
      expect(entry!.manifest.id).toBe('my-plugin');
      expect(entry!.source).toBe('builtin');
    });

    it('handles plugins with null exports (load-failed)', () => {
      registry.register(makeLoadedPlugin(
        { id: 'broken', version: '0.1.0', kind: 'provider', entry: './index.js', providers: ['broken'] },
        null,
      ));

      expect(registry.size).toBe(1);
      expect(registry.listPlugins()).toEqual(['broken']);
      // Provider is NOT registered since exports are null
      expect(registry.getProvider('broken')).toBeUndefined();
      expect(registry.listProviderIds()).toEqual([]);
    });
  });
});
