// ─────────────────────────────────────────────────────────────
// Adapted from OpenClaw (MIT, © Peter Steinberger)
//   Origin: src/plugins/loader.ts (registry portion)
//   Origin SHA: 778ac4330aa32b9ce4482f0d1a3d4f744ff7f17f
//   Ported: 2026-04-16
// ─────────────────────────────────────────────────────────────

/**
 * Plugin registry — maps plugin IDs to loaded manifests + runtime exports.
 *
 * The registry is a read-only view built from the loader output.
 * No side effects on read; mutations only via `register()` during bootstrap.
 *
 */

import type {
  AlduinPluginManifest,
  ProviderPlugin,
  SkillPlugin,
  SkillManifestEntry,
  ToolPlugin,
  ToolDescriptor,
} from '@alduin/plugin-sdk';

import type { LoadedPlugin, PluginSource } from './types.js';

// ── Registry entry ──────────────────────────────────────────────────────────

export interface RegistryEntry {
  manifest: AlduinPluginManifest;
  rootDir: string;
  source: PluginSource;
}

interface ProviderEntry extends RegistryEntry {
  manifest: AlduinPluginManifest & { kind: 'provider' };
  plugin: ProviderPlugin;
}

interface SkillEntry extends RegistryEntry {
  manifest: AlduinPluginManifest & { kind: 'skill' };
  plugin: SkillPlugin;
}

interface ToolEntry extends RegistryEntry {
  manifest: AlduinPluginManifest & { kind: 'tool' };
  plugin: ToolPlugin;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Centralised registry of all loaded plugins.
 *
 * Built once during bootstrap from the loader output.  The registry is
 * consumed by:
 *   - `ProviderRegistry` (resolves provider ID → ProviderPlugin)
 *   - `SkillRegistry` (collects manifest entries for orchestrator context)
 *   - Executor dispatch (routes tool calls to the owning ToolPlugin)
 *   - `alduin plugins list` CLI command
 */
export class PluginRegistry {
  private providers = new Map<string, ProviderEntry>();
  private skills = new Map<string, SkillEntry>();
  private tools = new Map<string, ToolEntry>();
  /** All registered plugins by plugin ID. */
  private allById = new Map<string, RegistryEntry>();

  /**
   * Register a loaded plugin.
   * Call this once per successfully loaded plugin during bootstrap.
   */
  register(loaded: LoadedPlugin): void {
    const base: RegistryEntry = {
      manifest: loaded.manifest,
      rootDir: loaded.rootDir,
      source: loaded.source,
    };

    this.allById.set(loaded.manifest.id, base);

    if (!loaded.exports) return;

    switch (loaded.exports.kind) {
      case 'provider': {
        const entry: ProviderEntry = {
          ...base,
          manifest: loaded.manifest as ProviderEntry['manifest'],
          plugin: loaded.exports.plugin,
        };
        // Index by each provider ID the plugin claims
        if (loaded.manifest.kind === 'provider') {
          for (const providerId of loaded.manifest.providers) {
            this.providers.set(providerId, entry);
          }
        }
        break;
      }

      case 'skill': {
        const entry: SkillEntry = {
          ...base,
          manifest: loaded.manifest as SkillEntry['manifest'],
          plugin: loaded.exports.plugin,
        };
        this.skills.set(loaded.manifest.id, entry);
        break;
      }

      case 'tool': {
        const entry: ToolEntry = {
          ...base,
          manifest: loaded.manifest as ToolEntry['manifest'],
          plugin: loaded.exports.plugin,
        };
        this.tools.set(loaded.manifest.id, entry);
        break;
      }
    }
  }

  // ── Provider queries ────────────────────────────────────────────────────

  /**
   * Get a provider plugin by provider ID (e.g. "openrouter", "anthropic").
   * Returns undefined if no plugin registered that provider.
   */
  getProvider(id: string): ProviderPlugin | undefined {
    return this.providers.get(id)?.plugin;
  }

  /** List all registered provider IDs. */
  listProviderIds(): string[] {
    return Array.from(this.providers.keys());
  }

  /** Check whether a provider ID is registered. */
  hasProvider(id: string): boolean {
    return this.providers.has(id);
  }

  // ── Skill queries ─────────────────────────────────────────────────────

  /**
   * Collect compact manifest entries from all skill plugins.
   * Each entry is ~100 tokens — suitable for injection into orchestrator context.
   */
  listSkills(): SkillManifestEntry[] {
    const entries: SkillManifestEntry[] = [];
    for (const skillEntry of this.skills.values()) {
      entries.push(...skillEntry.plugin.getManifestEntries());
    }
    return entries;
  }

  /** Get a skill plugin by plugin ID. */
  getSkill(id: string): SkillPlugin | undefined {
    return this.skills.get(id)?.plugin;
  }

  // ── Tool queries ──────────────────────────────────────────────────────

  /**
   * List all tools across all tool plugins.
   * Returns descriptors suitable for the executor's tool list.
   */
  listTools(): ToolDescriptor[] {
    const descriptors: ToolDescriptor[] = [];
    for (const toolEntry of this.tools.values()) {
      descriptors.push(...toolEntry.plugin.listTools());
    }
    return descriptors;
  }

  /**
   * Find the tool plugin that owns a given tool name.
   * Returns undefined if no plugin exposes that tool.
   */
  getToolOwner(toolName: string): ToolPlugin | undefined {
    for (const toolEntry of this.tools.values()) {
      const names = toolEntry.plugin.listTools().map((t) => t.name);
      if (names.includes(toolName)) {
        return toolEntry.plugin;
      }
    }
    return undefined;
  }

  // ── General queries ───────────────────────────────────────────────────

  /** List all registered plugin IDs. */
  listPlugins(): string[] {
    return Array.from(this.allById.keys());
  }

  /** Get the registry entry for a plugin by ID. */
  getPluginEntry(id: string): RegistryEntry | undefined {
    return this.allById.get(id);
  }

  /** Number of registered plugins. */
  get size(): number {
    return this.allById.size;
  }
}
