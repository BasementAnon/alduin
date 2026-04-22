/**
 * definePlugin() — typed identity helper (like Vite's defineConfig).
 *
 * Narrows the manifest `kind` field so TypeScript can infer the correct
 * plugin type at the call site.  No side effects, no validation — this
 * is purely a type-level convenience.  Validation happens in the loader.
 *
 * Usage:
 *
 *   import { definePlugin } from '@alduin/plugin-sdk';
 *
 *   export default definePlugin({
 *     id: 'my-provider',
 *     version: '0.1.0',
 *     kind: 'provider',
 *     entry: './dist/index.js',
 *     providers: ['my-provider'],
 *   });
 */

import type { AlduinPluginManifest } from './manifest.js';

/**
 * Identity function that returns the manifest unchanged.
 * The generic constraint ensures TypeScript narrows `kind` at the call site,
 * giving plugin authors autocomplete and exhaustive-check support.
 */
export function definePlugin<T extends AlduinPluginManifest>(manifest: T): T {
  return manifest;
}
