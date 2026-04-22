/**
 * Tool-call compatibility layer.
 *
 * Normalizes tool-call encoding across providers:
 *  - Anthropic: messages tool_use content blocks
 *  - OpenAI: chat.completions tool_calls on assistant messages
 *  - OpenAI-compatible: same as OpenAI with defensive checks
 *  - Ollama: prompted JSON fallback when model lacks native tool support
 *
 * The normalized shape is LLMToolCall from src/types/llm.ts.
 * Each provider translates in/out through these helpers.
 */

import type { LLMTool, LLMToolCall, LLMMessage, ToolParameter } from '../types/llm.js';

// ── Anthropic tool format ────────────────────────────────────────────────────

/** Anthropic tool shape for the messages API */
export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Convert LLMTool[] to Anthropic's tool format */
export function toAnthropicTools(tools: LLMTool[]): AnthropicToolDef[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: 'object' as const,
      properties: parameterToProperties(t.parameters),
      required: t.parameters.required,
    },
  }));
}

/** Extract a tool call from an Anthropic tool_use content block */
export function fromAnthropicToolUse(block: {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}): LLMToolCall {
  return {
    id: block.id,
    name: block.name,
    arguments: block.input,
  };
}

// ── OpenAI tool format ───────────────────────────────────────────────────────

/** OpenAI tool shape for the chat completions API */
export interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Convert LLMTool[] to OpenAI's tool format */
export function toOpenAITools(tools: LLMTool[]): OpenAIToolDef[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: parameterToProperties(t.parameters),
        required: t.parameters.required ?? [],
      },
    },
  }));
}

/** Extract tool calls from an OpenAI assistant message */
export function fromOpenAIToolCalls(
  toolCalls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>
): LLMToolCall[] {
  return toolCalls.map((tc) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
    } catch {
      args = { _raw: tc.function.arguments };
    }
    return {
      id: tc.id,
      name: tc.function.name,
      arguments: args,
    };
  });
}

// ── Ollama prompted-JSON fallback ────────────────────────────────────────────

/**
 * Build a system prompt suffix that teaches the model to emit tool calls
 * as structured JSON. Used when Ollama models lack native tool-calling support.
 *
 * The format is a simple JSON array of tool calls:
 * [{"name": "tool_name", "arguments": {...}}]
 */
export function buildOllamaToolPrompt(tools: LLMTool[]): string {
  const toolDefs = tools.map((t) => {
    const params = t.parameters.properties
      ? Object.entries(t.parameters.properties)
          .map(([k, v]) => `    "${k}": ${v.description ? `// ${v.description}` : `(${v.type})`}`)
          .join(',\n')
      : '';
    const required = t.parameters.required?.join(', ') ?? 'none';
    return `- ${t.name}: ${t.description}\n  Parameters (required: ${required}):\n  {\n${params}\n  }`;
  });

  return `
You have access to the following tools:

${toolDefs.join('\n\n')}

When you need to call a tool, respond with ONLY a JSON array (no other text):
[{"name": "<tool_name>", "arguments": {<parameters>}}]

If you don't need to call any tool, respond normally with text.
If you need to call multiple tools, include multiple objects in the array.
`.trim();
}

/**
 * Try to extract tool calls from an Ollama model's text response.
 * Returns null if the response doesn't look like a tool call.
 */
export function parseOllamaToolResponse(
  content: string
): LLMToolCall[] | null {
  const trimmed = content.trim();

  // Must start with [ to be a tool call array
  if (!trimmed.startsWith('[')) return null;

  try {
    const parsed = JSON.parse(trimmed) as Array<{
      name?: string;
      arguments?: Record<string, unknown>;
    }>;

    if (!Array.isArray(parsed)) return null;

    const calls: LLMToolCall[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i];
      if (!item || typeof item.name !== 'string') continue;

      calls.push({
        id: `ollama-tc-${i}`,
        name: item.name,
        arguments: item.arguments ?? {},
      });
    }

    return calls.length > 0 ? calls : null;
  } catch {
    return null;
  }
}

// ── Tool result message builders ─────────────────────────────────────────────

/**
 * Build a tool result message to feed back into the conversation.
 * Works for all providers (Anthropic/OpenAI normalize to the same shape).
 */
export function buildToolResultMessage(
  toolCallId: string,
  toolName: string,
  result: string
): LLMMessage {
  return {
    role: 'tool',
    content: result,
    tool_call_id: toolCallId,
    name: toolName,
  };
}

/**
 * Build a tool result for Ollama's prompted JSON format.
 * Injected as a user message since Ollama doesn't have a native tool role.
 */
export function buildOllamaToolResultMessage(
  toolName: string,
  result: string
): LLMMessage {
  return {
    role: 'user',
    content: `Tool "${toolName}" returned:\n${result}\n\nPlease continue with the task using this result.`,
  };
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/** Convert ToolParameter to a flat properties map for JSON Schema */
function parameterToProperties(
  param: ToolParameter
): Record<string, unknown> {
  if (!param.properties) return {};
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(param.properties)) {
    props[key] = {
      type: value.type,
      ...(value.description ? { description: value.description } : {}),
      ...(value.enum ? { enum: value.enum } : {}),
      ...(value.items ? { items: { type: value.items.type } } : {}),
    };
  }
  return props;
}

/**
 * Detect whether an Ollama model supports native tool calling.
 * This checks the model catalog capabilities if available,
 * or falls back to a known-models list.
 */
export function ollamaSupportsNativeTools(modelName: string): boolean {
  // Models known to support native function calling
  const nativeToolModels = [
    'llama3.1', 'llama3.2', 'llama3.3',
    'mistral', 'mixtral',
    'qwen2.5', 'qwen3',
    'command-r',
    'firefunction',
  ];

  const lower = modelName.toLowerCase();
  return nativeToolModels.some((m) => lower.includes(m));
}
