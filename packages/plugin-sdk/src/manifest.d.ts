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
/** Schema for the `contributes` block common to all plugin kinds. */
export declare const pluginContributionSchema: z.ZodObject<{
    /** Relative path to a JSON Schema fragment merged into schema.generated.ts. */
    config_schema: z.ZodOptional<z.ZodString>;
    /** Relative path to a hints JSON file (label, help, sensitive, advanced). */
    config_hints: z.ZodOptional<z.ZodString>;
    /** Relative path to a models catalog JSON file (provider plugins only). */
    models_catalog: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    config_schema?: string | undefined;
    config_hints?: string | undefined;
    models_catalog?: string | undefined;
}, {
    config_schema?: string | undefined;
    config_hints?: string | undefined;
    models_catalog?: string | undefined;
}>;
/** Inferred TypeScript type for plugin contributions. */
export type PluginContribution = z.infer<typeof pluginContributionSchema>;
export declare const providerManifestSchema: z.ZodObject<{
    kind: z.ZodLiteral<"provider">;
    /** Provider IDs this plugin registers (e.g. ["openrouter"]). */
    providers: z.ZodArray<z.ZodString, "many">;
    /** Env vars required per provider for auth (e.g. { openrouter: ["OPENROUTER_API_KEY"] }). */
    providerAuthEnvVars: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString, "many">>>;
    /** Unique plugin identifier (e.g. "openrouter", "summarize", "web-search"). */
    id: z.ZodString;
    /** SemVer version string. */
    version: z.ZodString;
    /** Relative path to the plugin's JS entry module. */
    entry: z.ZodString;
    /** Optional human-readable description. */
    description: z.ZodOptional<z.ZodString>;
    /** What the plugin contributes to the host. */
    contributes: z.ZodOptional<z.ZodObject<{
        /** Relative path to a JSON Schema fragment merged into schema.generated.ts. */
        config_schema: z.ZodOptional<z.ZodString>;
        /** Relative path to a hints JSON file (label, help, sensitive, advanced). */
        config_hints: z.ZodOptional<z.ZodString>;
        /** Relative path to a models catalog JSON file (provider plugins only). */
        models_catalog: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    }, {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    }>>;
}, "strict", z.ZodTypeAny, {
    providers: string[];
    entry: string;
    kind: "provider";
    id: string;
    version: string;
    providerAuthEnvVars?: Record<string, string[]> | undefined;
    description?: string | undefined;
    contributes?: {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    } | undefined;
}, {
    providers: string[];
    entry: string;
    kind: "provider";
    id: string;
    version: string;
    providerAuthEnvVars?: Record<string, string[]> | undefined;
    description?: string | undefined;
    contributes?: {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    } | undefined;
}>;
export declare const skillManifestSchema: z.ZodObject<{
    kind: z.ZodLiteral<"skill">;
    /** Skill IDs this plugin registers. */
    skills: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    /** Unique plugin identifier (e.g. "openrouter", "summarize", "web-search"). */
    id: z.ZodString;
    /** SemVer version string. */
    version: z.ZodString;
    /** Relative path to the plugin's JS entry module. */
    entry: z.ZodString;
    /** Optional human-readable description. */
    description: z.ZodOptional<z.ZodString>;
    /** What the plugin contributes to the host. */
    contributes: z.ZodOptional<z.ZodObject<{
        /** Relative path to a JSON Schema fragment merged into schema.generated.ts. */
        config_schema: z.ZodOptional<z.ZodString>;
        /** Relative path to a hints JSON file (label, help, sensitive, advanced). */
        config_hints: z.ZodOptional<z.ZodString>;
        /** Relative path to a models catalog JSON file (provider plugins only). */
        models_catalog: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    }, {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    }>>;
}, "strict", z.ZodTypeAny, {
    entry: string;
    kind: "skill";
    id: string;
    version: string;
    description?: string | undefined;
    contributes?: {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    } | undefined;
    skills?: string[] | undefined;
}, {
    entry: string;
    kind: "skill";
    id: string;
    version: string;
    description?: string | undefined;
    contributes?: {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    } | undefined;
    skills?: string[] | undefined;
}>;
export declare const toolManifestSchema: z.ZodObject<{
    kind: z.ZodLiteral<"tool">;
    /** Tool names this plugin exposes (e.g. ["web-search", "calculator"]). */
    tools: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    /** Unique plugin identifier (e.g. "openrouter", "summarize", "web-search"). */
    id: z.ZodString;
    /** SemVer version string. */
    version: z.ZodString;
    /** Relative path to the plugin's JS entry module. */
    entry: z.ZodString;
    /** Optional human-readable description. */
    description: z.ZodOptional<z.ZodString>;
    /** What the plugin contributes to the host. */
    contributes: z.ZodOptional<z.ZodObject<{
        /** Relative path to a JSON Schema fragment merged into schema.generated.ts. */
        config_schema: z.ZodOptional<z.ZodString>;
        /** Relative path to a hints JSON file (label, help, sensitive, advanced). */
        config_hints: z.ZodOptional<z.ZodString>;
        /** Relative path to a models catalog JSON file (provider plugins only). */
        models_catalog: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    }, {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    }>>;
}, "strict", z.ZodTypeAny, {
    entry: string;
    kind: "tool";
    id: string;
    version: string;
    tools?: string[] | undefined;
    description?: string | undefined;
    contributes?: {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    } | undefined;
}, {
    entry: string;
    kind: "tool";
    id: string;
    version: string;
    tools?: string[] | undefined;
    description?: string | undefined;
    contributes?: {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    } | undefined;
}>;
/** Discriminated union of all three manifest kinds. */
export declare const alduinPluginManifestSchema: z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
    kind: z.ZodLiteral<"provider">;
    /** Provider IDs this plugin registers (e.g. ["openrouter"]). */
    providers: z.ZodArray<z.ZodString, "many">;
    /** Env vars required per provider for auth (e.g. { openrouter: ["OPENROUTER_API_KEY"] }). */
    providerAuthEnvVars: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString, "many">>>;
    /** Unique plugin identifier (e.g. "openrouter", "summarize", "web-search"). */
    id: z.ZodString;
    /** SemVer version string. */
    version: z.ZodString;
    /** Relative path to the plugin's JS entry module. */
    entry: z.ZodString;
    /** Optional human-readable description. */
    description: z.ZodOptional<z.ZodString>;
    /** What the plugin contributes to the host. */
    contributes: z.ZodOptional<z.ZodObject<{
        /** Relative path to a JSON Schema fragment merged into schema.generated.ts. */
        config_schema: z.ZodOptional<z.ZodString>;
        /** Relative path to a hints JSON file (label, help, sensitive, advanced). */
        config_hints: z.ZodOptional<z.ZodString>;
        /** Relative path to a models catalog JSON file (provider plugins only). */
        models_catalog: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    }, {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    }>>;
}, "strict", z.ZodTypeAny, {
    providers: string[];
    entry: string;
    kind: "provider";
    id: string;
    version: string;
    providerAuthEnvVars?: Record<string, string[]> | undefined;
    description?: string | undefined;
    contributes?: {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    } | undefined;
}, {
    providers: string[];
    entry: string;
    kind: "provider";
    id: string;
    version: string;
    providerAuthEnvVars?: Record<string, string[]> | undefined;
    description?: string | undefined;
    contributes?: {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    } | undefined;
}>, z.ZodObject<{
    kind: z.ZodLiteral<"skill">;
    /** Skill IDs this plugin registers. */
    skills: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    /** Unique plugin identifier (e.g. "openrouter", "summarize", "web-search"). */
    id: z.ZodString;
    /** SemVer version string. */
    version: z.ZodString;
    /** Relative path to the plugin's JS entry module. */
    entry: z.ZodString;
    /** Optional human-readable description. */
    description: z.ZodOptional<z.ZodString>;
    /** What the plugin contributes to the host. */
    contributes: z.ZodOptional<z.ZodObject<{
        /** Relative path to a JSON Schema fragment merged into schema.generated.ts. */
        config_schema: z.ZodOptional<z.ZodString>;
        /** Relative path to a hints JSON file (label, help, sensitive, advanced). */
        config_hints: z.ZodOptional<z.ZodString>;
        /** Relative path to a models catalog JSON file (provider plugins only). */
        models_catalog: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    }, {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    }>>;
}, "strict", z.ZodTypeAny, {
    entry: string;
    kind: "skill";
    id: string;
    version: string;
    description?: string | undefined;
    contributes?: {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    } | undefined;
    skills?: string[] | undefined;
}, {
    entry: string;
    kind: "skill";
    id: string;
    version: string;
    description?: string | undefined;
    contributes?: {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    } | undefined;
    skills?: string[] | undefined;
}>, z.ZodObject<{
    kind: z.ZodLiteral<"tool">;
    /** Tool names this plugin exposes (e.g. ["web-search", "calculator"]). */
    tools: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    /** Unique plugin identifier (e.g. "openrouter", "summarize", "web-search"). */
    id: z.ZodString;
    /** SemVer version string. */
    version: z.ZodString;
    /** Relative path to the plugin's JS entry module. */
    entry: z.ZodString;
    /** Optional human-readable description. */
    description: z.ZodOptional<z.ZodString>;
    /** What the plugin contributes to the host. */
    contributes: z.ZodOptional<z.ZodObject<{
        /** Relative path to a JSON Schema fragment merged into schema.generated.ts. */
        config_schema: z.ZodOptional<z.ZodString>;
        /** Relative path to a hints JSON file (label, help, sensitive, advanced). */
        config_hints: z.ZodOptional<z.ZodString>;
        /** Relative path to a models catalog JSON file (provider plugins only). */
        models_catalog: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    }, {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    }>>;
}, "strict", z.ZodTypeAny, {
    entry: string;
    kind: "tool";
    id: string;
    version: string;
    tools?: string[] | undefined;
    description?: string | undefined;
    contributes?: {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    } | undefined;
}, {
    entry: string;
    kind: "tool";
    id: string;
    version: string;
    tools?: string[] | undefined;
    description?: string | undefined;
    contributes?: {
        config_schema?: string | undefined;
        config_hints?: string | undefined;
        models_catalog?: string | undefined;
    } | undefined;
}>]>;
/** Inferred TypeScript type for any valid `alduin.plugin.json`. */
export type AlduinPluginManifest = z.infer<typeof alduinPluginManifestSchema>;
/** Provider-specific manifest. */
export type ProviderManifest = z.infer<typeof providerManifestSchema>;
/** Skill-specific manifest. */
export type SkillManifest = z.infer<typeof skillManifestSchema>;
/** Tool-specific manifest. */
export type ToolManifest = z.infer<typeof toolManifestSchema>;
//# sourceMappingURL=manifest.d.ts.map