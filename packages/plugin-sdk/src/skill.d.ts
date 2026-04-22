import type { PluginContext } from './context.js';
/**
 * Model hints that guide the orchestrator's executor selection.
 */
export interface SkillModelHints {
    /** Preferred models, in priority order. */
    prefer: string[];
    /** Fallback local model (e.g. "ollama/qwen2.5-coder:32b"). */
    fallback_local?: string;
}
/**
 * Compact manifest entry for a skill — what the orchestrator sees.
 * Must fit in ~100 tokens so the orchestrator can carry 30+ of them
 * without blowing its context budget.
 */
export interface SkillManifestEntry {
    id: string;
    description: string;
    inputs: string[];
    model_hints: SkillModelHints;
}
/**
 * Full skill definition — loaded on demand when the orchestrator selects
 * this skill for a task.
 */
export interface SkillDefinition extends SkillManifestEntry {
    /** The system prompt loaded into the executor. */
    prompt: string;
    /** Environment variables required to run this skill. */
    env_required: string[];
    /** OS constraint ("any", "linux", "darwin", "win32"). */
    os: string;
    /** Whether this skill may spawn sub-orchestrators. */
    allow_sub_orchestration: boolean;
    /** Optional code module path (relative to skill dir). */
    code_module?: string;
}
/**
 * The interface a skill plugin must implement.
 *
 * Most skills are markdown-only (parsed by the frontmatter registry).
 * This interface exists for skills that need runtime logic beyond what
 * the prompt alone can express.
 */
export interface SkillPlugin {
    /** Skill identifier — must match what the manifest declares. */
    readonly id: string;
    /**
     * Return the compact manifest entries this plugin provides.
     * Called once at registration time.
     */
    getManifestEntries(): SkillManifestEntry[];
    /**
     * Load the full definition for a skill by ID.
     * Called on demand when the orchestrator selects the skill.
     */
    getDefinition(skillId: string, ctx: PluginContext): SkillDefinition | null;
}
//# sourceMappingURL=skill.d.ts.map