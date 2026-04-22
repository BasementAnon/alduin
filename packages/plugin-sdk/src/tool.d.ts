/**
 * Tool plugin interface — tools callable by executors.
 *
 * Tool plugins are implemented as in-process MCP servers (Phase 5.3).
 * This interface defines the minimal contract the host needs to load
 * and route tool calls.
 */
import type { PluginContext } from './context.js';
/** JSON Schema describing a tool's input parameters. */
export interface ToolInputSchema {
    type: 'object';
    properties: Record<string, {
        type: string;
        description?: string;
        enum?: string[];
        default?: unknown;
    }>;
    required?: string[];
}
/** Descriptor for a single tool. */
export interface ToolDescriptor {
    /** Unique tool name (e.g. "web-search", "calculator"). */
    name: string;
    /** Human-readable description for the executor's tool list. */
    description: string;
    /** JSON Schema for the tool's input. */
    inputSchema: ToolInputSchema;
}
/** Result of a tool invocation. */
export interface ToolResult {
    /** Whether the tool call succeeded. */
    ok: boolean;
    /** Stringified output (executor receives this). */
    output?: string;
    /** Error message on failure. */
    error?: string;
}
/**
 * The interface a tool plugin must implement.
 */
export interface ToolPlugin {
    /** Plugin identifier — must match what the manifest declares. */
    readonly id: string;
    /**
     * List the tools this plugin exposes.
     * Called once at registration time.
     */
    listTools(): ToolDescriptor[];
    /**
     * Invoke a tool by name with the given arguments.
     *
     * The host enforces PolicyVerdict.allowed_tools before calling this —
     * the plugin does not need to check policy.
     */
    invoke(toolName: string, args: Record<string, unknown>, ctx: PluginContext): Promise<ToolResult>;
}
//# sourceMappingURL=tool.d.ts.map