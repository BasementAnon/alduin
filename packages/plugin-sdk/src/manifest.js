// ─────────────────────────────────────────────────────────────
// Adapted from OpenClaw (MIT, © Peter Steinberger)
//   Origin: src/plugin-sdk/plugin-entry.ts (manifest shape)
//   Origin SHA: 778ac4330aa32b9ce4482f0d1a3d4f744ff7f17f
//   Ported: 2026-04-16
// ─────────────────────────────────────────────────────────────
/**
 * Zod schemas for `alduin.plugin.json` — the manifest every Alduin plugin
 * must ship.  These are the **source of truth** for manifest validation in
 * the loader (`src/plugins/loader.ts`) and in `alduin doctor`.
 *
 * Design constraint: this file has zero runtime dependencies beyond `zod`.
 * It is part of `@alduin/plugin-sdk`, which is a forever-stable public
 * contract.  Breaking changes require a major version bump.
 */
import { z } from 'zod';
// ── Shared fragments ─────────────────────────────────────────────────────────
/** Schema for the `contributes` block common to all plugin kinds. */
export const pluginContributionSchema = z.object({
    /** Relative path to a JSON Schema fragment merged into schema.generated.ts. */
    config_schema: z.string().optional(),
    /** Relative path to a hints JSON file (label, help, sensitive, advanced). */
    config_hints: z.string().optional(),
    /** Relative path to a models catalog JSON file (provider plugins only). */
    models_catalog: z.string().optional(),
}).strict();
// ── Per-kind manifest schemas ────────────────────────────────────────────────
const baseFields = {
    /** Unique plugin identifier (e.g. "openrouter", "summarize", "web-search"). */
    id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'Plugin id must be lowercase alphanumeric with hyphens'),
    /** SemVer version string. */
    version: z.string().regex(/^\d+\.\d+\.\d+/, 'version must be semver'),
    /** Relative path to the plugin's JS entry module. */
    entry: z.string().min(1),
    /** Optional human-readable description. */
    description: z.string().optional(),
    /** What the plugin contributes to the host. */
    contributes: pluginContributionSchema.optional(),
};
export const providerManifestSchema = z.object({
    ...baseFields,
    kind: z.literal('provider'),
    /** Provider IDs this plugin registers (e.g. ["openrouter"]). */
    providers: z.array(z.string().min(1)).min(1),
    /** Env vars required per provider for auth (e.g. { openrouter: ["OPENROUTER_API_KEY"] }). */
    providerAuthEnvVars: z.record(z.string(), z.array(z.string())).optional(),
}).strict();
export const skillManifestSchema = z.object({
    ...baseFields,
    kind: z.literal('skill'),
    /** Skill IDs this plugin registers. */
    skills: z.array(z.string().min(1)).min(1).optional(),
}).strict();
export const toolManifestSchema = z.object({
    ...baseFields,
    kind: z.literal('tool'),
    /** Tool names this plugin exposes (e.g. ["web-search", "calculator"]). */
    tools: z.array(z.string().min(1)).min(1).optional(),
}).strict();
/** Discriminated union of all three manifest kinds. */
export const alduinPluginManifestSchema = z.discriminatedUnion('kind', [
    providerManifestSchema,
    skillManifestSchema,
    toolManifestSchema,
]);
//# sourceMappingURL=manifest.js.map