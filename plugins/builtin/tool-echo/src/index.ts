/**
 * Echo tool plugin — reference implementation for testing the MCP host.
 *
 * Exposes a single tool "echo" that returns its input as output.
 * Used in MCP host integration tests to verify the full pipeline:
 * registration → policy check → invocation → trace logging.
 *
 */

import type {
  ToolPlugin,
  ToolDescriptor,
  ToolResult,
  PluginContext,
} from '@alduin/plugin-sdk';

export const tool: ToolPlugin = {
  id: 'tool-echo',

  listTools(): ToolDescriptor[] {
    return [
      {
        name: 'echo',
        description: 'Echoes back the provided message. For testing only.',
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'The message to echo back',
            },
            delay_ms: {
              type: 'number',
              description: 'Optional delay in ms before responding (for timeout tests)',
            },
            should_throw: {
              type: 'string',
              description: 'If set, the tool throws an error with this message',
            },
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

    // Simulate crash for testing
    const shouldThrow = args['should_throw'] as string | undefined;
    if (shouldThrow) {
      throw new Error(shouldThrow);
    }

    // Optional delay for timeout testing
    const delayMs = args['delay_ms'] as number | undefined;
    if (delayMs && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const message = args['message'] as string;
    return {
      ok: true,
      output: `echo: ${message}`,
    };
  },
};
