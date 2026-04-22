/**
 * In-process MCP tool host.
 *
 * Routes LLMToolCall invocations to owning ToolPlugins, enforces
 * PolicyVerdict.allowed_tools, and logs every call into the trace.
 *
 * Design: tools run in-process (not subprocesses) per the Plugin
 * Architecture §4 commitment. Each ToolPlugin is loaded by the
 * PluginRegistry; the host merely dispatches and guards.
 *
 */

import type { ToolPlugin, ToolResult, ToolDescriptor } from '@alduin/plugin-sdk';
import type { PluginContext } from '@alduin/plugin-sdk';
import type { LLMToolCall } from '../types/llm.js';
import type { PolicyVerdict } from '../auth/policy.js';
import type { TraceLogger } from '../trace/logger.js';
import { redactSecrets } from '../memory/redactor.js';
import { raceWithTimeout } from '../util/timeout.js';

/**
 * Redact secrets and wrap a raw tool output in `<tool_output>` delimiter
 * tags before it is fed back into any LLM (executor re-entry, orchestrator
 * synthesis, etc.).
 *
 * The XML tags give the model a hard boundary between "data" and
 * "instructions" so an adversarial tool response cannot pretend to be a
 * new system prompt. H-8.
 *
 * We also redact any `</tool_output>` occurrences in the raw content so
 * untrusted data cannot forge the closing tag and smuggle text outside
 * the delimited region.
 */
export function formatToolOutputForLLM(
  rawOutput: string,
  opts?: { toolName?: string; redactPii?: boolean }
): string {
  const redacted = redactSecrets(rawOutput, opts?.redactPii ?? false);
  const withoutClose = redacted.replace(/<\/?tool_output>/gi, '[REDACTED_TAG]');
  const nameAttr = opts?.toolName
    ? ` name="${opts.toolName.replace(/["<>&]/g, '_')}"`
    : '';
  return `<tool_output${nameAttr}>\n${withoutClose}\n</tool_output>`;
}

/**
 * Default per-tool invocation timeout. A buggy or misbehaving plugin must
 * never be able to stall the orchestrator indefinitely. H-7.
 */
export const DEFAULT_TOOL_INVOKE_TIMEOUT_MS = 30_000;

// ── Tool invocation result ──────────────────────────────────────────────────

export type ToolInvokeStatus = 'ok' | 'error' | 'policy_denied' | 'not_found' | 'timeout';

export interface ToolInvokeResult {
  status: ToolInvokeStatus;
  /** Stringified output from the tool (empty on deny/not-found). */
  output: string;
  /** Error message when status is 'error' or 'policy_denied'. */
  error?: string;
  /** Which plugin handled the call (undefined on not_found). */
  plugin_id?: string;
  /** Wall-clock ms the invocation took. */
  latency_ms: number;
}

// ── MCP Host ────────────────────────────────────────────────────────────────

export class MCPToolHost {
  /** tool-name → { plugin, pluginId } */
  private toolIndex = new Map<string, { plugin: ToolPlugin; pluginId: string }>();
  /** All tool descriptors for the executor's tool list. */
  private descriptors: ToolDescriptor[] = [];
  private traceLogger?: TraceLogger;
  /** Per-call timeout (ms). Default 30s. H-7. */
  private invokeTimeoutMs: number;

  constructor(opts?: { traceLogger?: TraceLogger; invokeTimeoutMs?: number }) {
    this.traceLogger = opts?.traceLogger;
    this.invokeTimeoutMs = opts?.invokeTimeoutMs ?? DEFAULT_TOOL_INVOKE_TIMEOUT_MS;
  }

  // ── Registration ────────────────────────────────────────────────────────

  /**
   * Register a tool plugin. Indexes every tool the plugin exposes.
   * Throws on duplicate tool names (first-registered wins is NOT silent).
   */
  registerPlugin(plugin: ToolPlugin): void {
    const tools = plugin.listTools();
    for (const tool of tools) {
      if (this.toolIndex.has(tool.name)) {
        const existing = this.toolIndex.get(tool.name)!;
        throw new Error(
          `Tool name conflict: "${tool.name}" already registered by plugin "${existing.pluginId}"`
        );
      }
      this.toolIndex.set(tool.name, { plugin, pluginId: plugin.id });
      this.descriptors.push(tool);
    }
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  /** List all registered tool descriptors (for the executor's tool list). */
  listTools(): ToolDescriptor[] {
    return [...this.descriptors];
  }

  /** Check whether a tool name is registered. */
  hasTool(name: string): boolean {
    return this.toolIndex.has(name);
  }

  /** Get the plugin ID that owns a tool. */
  getToolOwner(name: string): string | undefined {
    return this.toolIndex.get(name)?.pluginId;
  }

  // ── Invocation ──────────────────────────────────────────────────────────

  /**
   * Invoke a tool call, enforcing the policy and logging to trace.
   *
   * Flow:
   * 1. Check tool exists → not_found
   * 2. Check allowed_tools policy → policy_denied
   * 3. Log tool_invoked trace event
   * 4. Call plugin.invoke() with a timeout wrapper
   * 5. Log tool_completed or tool_failed
   * 6. Return result
   */
  async invoke(
    call: LLMToolCall,
    policy: PolicyVerdict,
    ctx: PluginContext,
    taskId?: string,
  ): Promise<ToolInvokeResult> {
    const start = Date.now();

    // 1. Tool exists?
    const entry = this.toolIndex.get(call.name);
    if (!entry) {
      this.logTrace(taskId, 'tool_denied', {
        tool_name: call.name,
        tool_call_id: call.id,
        error: `Tool "${call.name}" not found`,
      });
      return {
        status: 'not_found',
        output: '',
        error: `Tool "${call.name}" is not registered`,
        latency_ms: Date.now() - start,
      };
    }

    // 2. Policy check
    if (!this.isToolAllowed(call.name, policy)) {
      this.logTrace(taskId, 'tool_denied', {
        tool_name: call.name,
        tool_plugin_id: entry.pluginId,
        tool_call_id: call.id,
        error: 'Blocked by allowed_tools policy',
      });
      return {
        status: 'policy_denied',
        output: '',
        error: `Tool "${call.name}" is not allowed by policy`,
        plugin_id: entry.pluginId,
        latency_ms: Date.now() - start,
      };
    }

    // 3. Log invocation start
    this.logTrace(taskId, 'tool_invoked', {
      tool_name: call.name,
      tool_plugin_id: entry.pluginId,
      tool_call_id: call.id,
    });

    // 4. Execute with crash + hang isolation.
    //
    // Wrap the plugin call in a Promise.race against a hard deadline so a
    // misbehaving tool cannot stall the orchestrator. If the plugin's
    // PluginContext exposes an AbortSignal (ctx.abortSignal — optional
    // per the SDK), we forward an AbortController so cooperating tools
    // can tear down in-flight work when the deadline fires. H-7.
    const timeoutMs = this.invokeTimeoutMs;
    const controller = new AbortController();
    const ctxWithSignal = {
      ...ctx,
      abortSignal: controller.signal,
    } as PluginContext & { abortSignal?: AbortSignal };

    const timeoutMessage = `Tool "${call.name}" timed out after ${timeoutMs}ms`;

    let result: ToolResult;
    try {
      result = await raceWithTimeout(
        entry.plugin.invoke(call.name, call.arguments, ctxWithSignal),
        timeoutMs,
        timeoutMessage,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const latencyMs = Date.now() - start;
      const isTimeout = error instanceof Error && error.message === timeoutMessage;

      if (isTimeout) {
        controller.abort();
        this.logTrace(taskId, 'tool_failed', {
          tool_name: call.name,
          tool_plugin_id: entry.pluginId,
          tool_call_id: call.id,
          error: `timeout after ${timeoutMs}ms`,
          latency_ms: latencyMs,
        });
        return {
          status: 'timeout',
          output: '',
          error: timeoutMessage,
          plugin_id: entry.pluginId,
          latency_ms: latencyMs,
        };
      }

      this.logTrace(taskId, 'tool_failed', {
        tool_name: call.name,
        tool_plugin_id: entry.pluginId,
        tool_call_id: call.id,
        error: errorMsg,
        latency_ms: latencyMs,
      });
      return {
        status: 'error',
        output: '',
        error: `Tool "${call.name}" crashed: ${errorMsg}`,
        plugin_id: entry.pluginId,
        latency_ms: latencyMs,
      };
    }

    const latencyMs = Date.now() - start;

    // 5. Log completion
    this.logTrace(taskId, 'tool_completed', {
      tool_name: call.name,
      tool_plugin_id: entry.pluginId,
      tool_call_id: call.id,
      tool_output: result.output ?? result.error ?? '',
      latency_ms: latencyMs,
    });

    return {
      status: result.ok ? 'ok' : 'error',
      output: result.output ?? '',
      error: result.error,
      plugin_id: entry.pluginId,
      latency_ms: latencyMs,
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /** Check whether a tool is allowed by the policy's allowed_tools list. */
  private isToolAllowed(toolName: string, policy: PolicyVerdict): boolean {
    const list = policy.allowed_tools;
    if (!list || list.length === 0) return true;
    if (list.includes('*')) return true;
    return list.includes(toolName);
  }

  /** Log a trace event if a trace logger + task ID are available. */
  private logTrace(
    taskId: string | undefined,
    eventType: 'tool_invoked' | 'tool_completed' | 'tool_denied' | 'tool_failed',
    data: {
      tool_name: string;
      tool_plugin_id?: string;
      tool_call_id?: string;
      tool_output?: string;
      error?: string;
      latency_ms?: number;
    },
  ): void {
    if (!this.traceLogger || !taskId) return;
    this.traceLogger.logEvent(taskId, {
      event_type: eventType,
      data: {
        tool_name: data.tool_name,
        tool_plugin_id: data.tool_plugin_id,
        tool_call_id: data.tool_call_id,
        tool_output: data.tool_output,
        error: data.error,
        latency_ms: data.latency_ms,
      },
    });
  }
}
