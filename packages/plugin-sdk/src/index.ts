/**
 * @alduin/plugin-sdk — public contract for Alduin plugins.
 *
 * This is a forever-stable surface.  Breaking changes require a major
 * version bump.  Keep exports minimal; every export is a commitment.
 *
 * Portions adapted from OpenClaw (MIT, © Peter Steinberger).
 * See ../../vendor/openclaw-ports/README.md for file-level provenance.
 */

// ── Plugin kinds ─────────────────────────────────────────────────────────────
export type { ProviderPlugin } from './provider.js';
export type {
  PluginLLMCompletionRequest,
  PluginLLMCompletionResponse,
  PluginLLMError,
  PluginLLMMessage,
  PluginLLMStreamChunk,
  PluginLLMTool,
  PluginLLMToolCall,
  PluginLLMUsage,
  PluginResult,
} from './provider.js';

export type { SkillPlugin, SkillManifestEntry, SkillDefinition, SkillModelHints } from './skill.js';
export type { ToolPlugin, ToolDescriptor, ToolResult, ToolInputSchema } from './tool.js';

// ── Manifest ─────────────────────────────────────────────────────────────────
export type { AlduinPluginManifest, PluginContribution, ProviderManifest, SkillManifest, ToolManifest } from './manifest.js';
export {
  alduinPluginManifestSchema,
  providerManifestSchema,
  skillManifestSchema,
  toolManifestSchema,
  pluginContributionSchema,
} from './manifest.js';

// ── Context ──────────────────────────────────────────────────────────────────
export type { PluginContext, PluginLogger } from './context.js';

// ── Helper ───────────────────────────────────────────────────────────────────
export { definePlugin } from './define.js';
