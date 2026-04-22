/**
 * @alduin/plugin-sdk — public contract for Alduin plugins.
 *
 * This is a forever-stable surface.  Breaking changes require a major
 * version bump.  Keep exports minimal; every export is a commitment.
 *
 * Portions adapted from OpenClaw (MIT, © Peter Steinberger).
 * See ../../vendor/openclaw-ports/README.md for file-level provenance.
 */
export { alduinPluginManifestSchema, providerManifestSchema, skillManifestSchema, toolManifestSchema, pluginContributionSchema, } from './manifest.js';
// ── Helper ───────────────────────────────────────────────────────────────────
export { definePlugin } from './define.js';
//# sourceMappingURL=index.js.map