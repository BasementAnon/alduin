// ─────────────────────────────────────────────────────────────
// Adapted from OpenClaw (MIT, © Peter Steinberger)
//   Origin: src/plugins/loader.ts (loaded-plugin shape)
//   Origin SHA: 778ac4330aa32b9ce4482f0d1a3d4f744ff7f17f
//   Ported: 2026-04-16
// ─────────────────────────────────────────────────────────────

/**
 * Internal types for the plugin host.
 *
 * These are NOT part of the public plugin-sdk contract — they describe
 * the host-side view of a loaded plugin (manifest + resolved paths +
 * runtime exports).
 */

import type {
  AlduinPluginManifest,
  ProviderPlugin,
  SkillPlugin,
  ToolPlugin,
} from '@alduin/plugin-sdk';

// ── Loaded plugin record ────────────────────────────────────────────────────

/** A plugin that has been discovered, validated, and had its entry loaded. */
export interface LoadedPlugin {
  /** The validated alduin.plugin.json manifest. */
  manifest: AlduinPluginManifest;
  /** Absolute path to the plugin root directory. */
  rootDir: string;
  /** Absolute path to the resolved entry module. */
  entryPath: string;
  /**
   * The runtime exports from the entry module.
   * Populated after successful dynamic import; null if load failed.
   */
  exports: PluginExports | null;
  /** How this plugin was discovered. */
  source: PluginSource;
}

/** Discriminated union of what a plugin entry module may export. */
export type PluginExports =
  | { kind: 'provider'; plugin: ProviderPlugin }
  | { kind: 'skill'; plugin: SkillPlugin }
  | { kind: 'tool'; plugin: ToolPlugin };

/** How the plugin was discovered. */
export type PluginSource =
  | 'builtin'         // plugins/builtin/*
  | 'node_modules'    // node_modules/@alduin-*/*
  | 'local';          // config.yaml plugins.local[]

// ── Loader result ───────────────────────────────────────────────────────────

/** Error produced during plugin loading. */
export interface PluginLoadError {
  /** Plugin ID (from manifest), or directory name if manifest failed. */
  pluginId: string;
  /** Human-readable error message (user-actionable). */
  message: string;
  /** Error classification for programmatic handling. */
  code:
    | 'manifest_not_found'
    | 'manifest_invalid'
    | 'entry_not_found'
    | 'entry_load_failed'
    | 'provider_conflict'
    | 'skill_conflict'
    | 'tool_conflict'
    | 'schema_drift';
}
