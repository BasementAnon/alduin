import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MCPToolHost } from './mcp-host.js';
import type { ToolPlugin, ToolDescriptor, ToolResult, PluginContext } from '@alduin/plugin-sdk';
import type { PolicyVerdict } from '../auth/policy.js';
import type { LLMToolCall } from '../types/llm.js';
import { TraceLogger } from '../trace/logger.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Minimal PluginContext stub */
const stubCtx: PluginContext = {
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  getCredential: async () => null,
  getConfig: () => undefined,
};

/** Default allow-all policy */
const ALLOW_ALL_POLICY: PolicyVerdict = {
  allowed: true,
  allowed_skills: ['*'],
  allowed_tools: ['*'],
  allowed_connectors: ['*'],
  allowed_executors: ['*'],
  cost_ceiling_usd: 2.0,
  model_tier_max: 'frontier',
  allowed_attachment_kinds: ['image', 'document', 'audio', 'voice', 'video', 'url'],
  requires_confirmation: [],
};

/** Policy that blocks the echo tool */
const DENY_ECHO_POLICY: PolicyVerdict = {
  ...ALLOW_ALL_POLICY,
  allowed_tools: ['search', 'calculator'], // echo is NOT listed
};

/** Echo tool plugin (inline, not importing from builtin to avoid path issues) */
function createEchoPlugin(): ToolPlugin {
  return {
    id: 'tool-echo',
    listTools(): ToolDescriptor[] {
      return [
        {
          name: 'echo',
          description: 'Echoes back the provided message',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'Message to echo' },
              should_throw: { type: 'string', description: 'If set, throw this error' },
            },
            required: ['message'],
          },
        },
      ];
    },
    async invoke(
      toolName: string,
      args: Record<string, unknown>,
      _ctx: PluginContext,
    ): Promise<ToolResult> {
      if (toolName !== 'echo') {
        return { ok: false, error: `Unknown tool: ${toolName}` };
      }
      const shouldThrow = args['should_throw'] as string | undefined;
      if (shouldThrow) throw new Error(shouldThrow);
      return { ok: true, output: `echo: ${args['message']}` };
    },
  };
}

/** A second tool plugin for conflict tests */
function createSearchPlugin(): ToolPlugin {
  return {
    id: 'tool-search',
    listTools(): ToolDescriptor[] {
      return [
        {
          name: 'search',
          description: 'Search the web',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ];
    },
    async invoke(_toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
      return { ok: true, output: `results for: ${args['query']}` };
    },
  };
}

function makeCall(name: string, args: Record<string, unknown>): LLMToolCall {
  return { id: `tc-${Date.now()}`, name, arguments: args };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('MCPToolHost', () => {
  let host: MCPToolHost;

  beforeEach(() => {
    host = new MCPToolHost();
  });

  // ── Registration ──────────────────────────────────────────────────────

  describe('registration', () => {
    it('registers a tool plugin and indexes its tools', () => {
      host.registerPlugin(createEchoPlugin());
      expect(host.hasTool('echo')).toBe(true);
      expect(host.getToolOwner('echo')).toBe('tool-echo');
      expect(host.listTools()).toHaveLength(1);
      expect(host.listTools()[0]!.name).toBe('echo');
    });

    it('registers multiple plugins', () => {
      host.registerPlugin(createEchoPlugin());
      host.registerPlugin(createSearchPlugin());
      expect(host.listTools()).toHaveLength(2);
      expect(host.hasTool('echo')).toBe(true);
      expect(host.hasTool('search')).toBe(true);
    });

    it('throws on duplicate tool names', () => {
      host.registerPlugin(createEchoPlugin());
      expect(() => host.registerPlugin(createEchoPlugin())).toThrow(
        'Tool name conflict: "echo" already registered by plugin "tool-echo"'
      );
    });
  });

  // ── End-to-end invocation ─────────────────────────────────────────────

  describe('echo tool end-to-end', () => {
    it('invokes the echo tool and returns output', async () => {
      host.registerPlugin(createEchoPlugin());
      const result = await host.invoke(
        makeCall('echo', { message: 'hello world' }),
        ALLOW_ALL_POLICY,
        stubCtx,
      );
      expect(result.status).toBe('ok');
      expect(result.output).toBe('echo: hello world');
      expect(result.plugin_id).toBe('tool-echo');
      expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    });

    it('returns not_found for unregistered tool', async () => {
      host.registerPlugin(createEchoPlugin());
      const result = await host.invoke(
        makeCall('nonexistent', {}),
        ALLOW_ALL_POLICY,
        stubCtx,
      );
      expect(result.status).toBe('not_found');
      expect(result.error).toContain('not registered');
    });
  });

  // ── Policy enforcement ────────────────────────────────────────────────

  describe('policy enforcement', () => {
    it('denies tool when not in allowed_tools', async () => {
      host.registerPlugin(createEchoPlugin());
      const result = await host.invoke(
        makeCall('echo', { message: 'test' }),
        DENY_ECHO_POLICY,
        stubCtx,
      );
      expect(result.status).toBe('policy_denied');
      expect(result.error).toContain('not allowed by policy');
      expect(result.plugin_id).toBe('tool-echo');
    });

    it('allows tool when listed in allowed_tools', async () => {
      host.registerPlugin(createSearchPlugin());
      const result = await host.invoke(
        makeCall('search', { query: 'test' }),
        DENY_ECHO_POLICY, // allows 'search'
        stubCtx,
      );
      expect(result.status).toBe('ok');
      expect(result.output).toBe('results for: test');
    });

    it('allows all tools with wildcard policy', async () => {
      host.registerPlugin(createEchoPlugin());
      const result = await host.invoke(
        makeCall('echo', { message: 'test' }),
        ALLOW_ALL_POLICY,
        stubCtx,
      );
      expect(result.status).toBe('ok');
    });

    it('allows all tools when allowed_tools is empty', async () => {
      host.registerPlugin(createEchoPlugin());
      const emptyPolicy: PolicyVerdict = { ...ALLOW_ALL_POLICY, allowed_tools: [] };
      const result = await host.invoke(
        makeCall('echo', { message: 'test' }),
        emptyPolicy,
        stubCtx,
      );
      expect(result.status).toBe('ok');
    });
  });

  // ── Crash isolation ───────────────────────────────────────────────────

  describe('crash isolation', () => {
    it('catches plugin exceptions and returns error status', async () => {
      host.registerPlugin(createEchoPlugin());
      const result = await host.invoke(
        makeCall('echo', { message: 'test', should_throw: 'kaboom!' }),
        ALLOW_ALL_POLICY,
        stubCtx,
      );
      expect(result.status).toBe('error');
      expect(result.error).toContain('kaboom!');
      expect(result.plugin_id).toBe('tool-echo');
    });

    it('host remains usable after a tool crash', async () => {
      host.registerPlugin(createEchoPlugin());

      // First call crashes
      const crash = await host.invoke(
        makeCall('echo', { message: 'x', should_throw: 'crash' }),
        ALLOW_ALL_POLICY,
        stubCtx,
      );
      expect(crash.status).toBe('error');

      // Second call succeeds — host is not corrupted
      const ok = await host.invoke(
        makeCall('echo', { message: 'recovery' }),
        ALLOW_ALL_POLICY,
        stubCtx,
      );
      expect(ok.status).toBe('ok');
      expect(ok.output).toBe('echo: recovery');
    });
  });

  // ── Trace logging ─────────────────────────────────────────────────────

  describe('trace logging', () => {
    it('logs tool_invoked and tool_completed events', async () => {
      const logger = new TraceLogger();
      const tracedHost = new MCPToolHost({ traceLogger: logger });
      tracedHost.registerPlugin(createEchoPlugin());

      const taskId = 'task-trace-1';
      logger.startTrace(taskId, 'test');

      await tracedHost.invoke(
        makeCall('echo', { message: 'traced' }),
        ALLOW_ALL_POLICY,
        stubCtx,
        taskId,
      );

      const trace = logger.getTrace(taskId);
      expect(trace).toBeDefined();
      const events = trace!.events;
      expect(events.some((e) => e.event_type === 'tool_invoked')).toBe(true);
      expect(events.some((e) => e.event_type === 'tool_completed')).toBe(true);

      const completed = events.find((e) => e.event_type === 'tool_completed')!;
      expect(completed.data.tool_name).toBe('echo');
      expect(completed.data.tool_output).toBe('echo: traced');
    });

    it('logs tool_denied when policy blocks', async () => {
      const logger = new TraceLogger();
      const tracedHost = new MCPToolHost({ traceLogger: logger });
      tracedHost.registerPlugin(createEchoPlugin());

      const taskId = 'task-trace-2';
      logger.startTrace(taskId, 'test');

      await tracedHost.invoke(
        makeCall('echo', { message: 'blocked' }),
        DENY_ECHO_POLICY,
        stubCtx,
        taskId,
      );

      const trace = logger.getTrace(taskId);
      const denied = trace!.events.find((e) => e.event_type === 'tool_denied');
      expect(denied).toBeDefined();
      expect(denied!.data.tool_name).toBe('echo');
    });

    it('logs tool_failed when plugin throws', async () => {
      const logger = new TraceLogger();
      const tracedHost = new MCPToolHost({ traceLogger: logger });
      tracedHost.registerPlugin(createEchoPlugin());

      const taskId = 'task-trace-3';
      logger.startTrace(taskId, 'test');

      await tracedHost.invoke(
        makeCall('echo', { message: 'x', should_throw: 'oops' }),
        ALLOW_ALL_POLICY,
        stubCtx,
        taskId,
      );

      const trace = logger.getTrace(taskId);
      const failed = trace!.events.find((e) => e.event_type === 'tool_failed');
      expect(failed).toBeDefined();
      expect(failed!.data.error).toContain('oops');
    });

    it('skips logging when no taskId provided', async () => {
      const logger = new TraceLogger();
      const tracedHost = new MCPToolHost({ traceLogger: logger });
      tracedHost.registerPlugin(createEchoPlugin());

      // No taskId → should not throw, should not log
      const result = await tracedHost.invoke(
        makeCall('echo', { message: 'no-trace' }),
        ALLOW_ALL_POLICY,
        stubCtx,
        // taskId omitted
      );
      expect(result.status).toBe('ok');
    });
  });
});
