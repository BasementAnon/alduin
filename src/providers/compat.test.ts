import { describe, it, expect } from 'vitest';
import {
  toAnthropicTools,
  fromAnthropicToolUse,
  toOpenAITools,
  fromOpenAIToolCalls,
  buildOllamaToolPrompt,
  parseOllamaToolResponse,
  buildToolResultMessage,
  buildOllamaToolResultMessage,
  ollamaSupportsNativeTools,
} from './compat.js';
import type { LLMTool } from '../types/llm.js';

const FIXTURE_TOOL: LLMTool = {
  name: 'get_weather',
  description: 'Get the current weather for a location',
  parameters: {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'City name' },
      units: { type: 'string', enum: ['celsius', 'fahrenheit'] },
    },
    required: ['location'],
  },
};

const FIXTURE_TOOLS: LLMTool[] = [
  FIXTURE_TOOL,
  {
    name: 'search',
    description: 'Search the web',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
];

// ── Anthropic round-trip ─────────────────────────────────────────────────────

describe('Anthropic tool compat', () => {
  it('toAnthropicTools converts LLMTool[] to Anthropic format', () => {
    const result = toAnthropicTools([FIXTURE_TOOL]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('get_weather');
    expect(result[0]!.description).toBe('Get the current weather for a location');
    expect(result[0]!.input_schema.type).toBe('object');
    expect(result[0]!.input_schema.properties).toHaveProperty('location');
    expect(result[0]!.input_schema.required).toEqual(['location']);
  });

  it('fromAnthropicToolUse extracts normalized LLMToolCall', () => {
    const block = {
      type: 'tool_use' as const,
      id: 'toolu_123',
      name: 'get_weather',
      input: { location: 'NYC', units: 'celsius' },
    };
    const result = fromAnthropicToolUse(block);
    expect(result.id).toBe('toolu_123');
    expect(result.name).toBe('get_weather');
    expect(result.arguments).toEqual({ location: 'NYC', units: 'celsius' });
  });

  it('round-trips Anthropic tools: define → call → result', () => {
    const tools = toAnthropicTools([FIXTURE_TOOL]);
    expect(tools[0]!.name).toBe('get_weather');

    const call = fromAnthropicToolUse({
      type: 'tool_use',
      id: 'toolu_456',
      name: 'get_weather',
      input: { location: 'London' },
    });
    expect(call.name).toBe('get_weather');

    const resultMsg = buildToolResultMessage(call.id, call.name, '72°F, Sunny');
    expect(resultMsg.role).toBe('tool');
    expect(resultMsg.tool_call_id).toBe('toolu_456');
    expect(resultMsg.content).toBe('72°F, Sunny');
  });
});

// ── OpenAI round-trip ────────────────────────────────────────────────────────

describe('OpenAI tool compat', () => {
  it('toOpenAITools converts LLMTool[] to OpenAI format', () => {
    const result = toOpenAITools([FIXTURE_TOOL]);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe('function');
    expect(result[0]!.function.name).toBe('get_weather');
    expect(result[0]!.function.parameters).toHaveProperty('properties');
  });

  it('fromOpenAIToolCalls extracts normalized LLMToolCall[]', () => {
    const toolCalls = [
      {
        id: 'call_abc',
        type: 'function' as const,
        function: {
          name: 'get_weather',
          arguments: '{"location":"NYC","units":"celsius"}',
        },
      },
    ];
    const result = fromOpenAIToolCalls(toolCalls);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('call_abc');
    expect(result[0]!.name).toBe('get_weather');
    expect(result[0]!.arguments).toEqual({ location: 'NYC', units: 'celsius' });
  });

  it('fromOpenAIToolCalls handles malformed JSON arguments', () => {
    const toolCalls = [
      {
        id: 'call_bad',
        type: 'function' as const,
        function: { name: 'broken', arguments: 'not json' },
      },
    ];
    const result = fromOpenAIToolCalls(toolCalls);
    expect(result[0]!.arguments).toEqual({ _raw: 'not json' });
  });

  it('round-trips OpenAI tools: define → call → result', () => {
    const tools = toOpenAITools(FIXTURE_TOOLS);
    expect(tools).toHaveLength(2);

    const calls = fromOpenAIToolCalls([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'search', arguments: '{"query":"weather NYC"}' },
      },
    ]);

    const resultMsg = buildToolResultMessage(calls[0]!.id, calls[0]!.name, 'Results...');
    expect(resultMsg.role).toBe('tool');
    expect(resultMsg.name).toBe('search');
  });
});

// ── Ollama prompted-JSON ─────────────────────────────────────────────────────

describe('Ollama tool compat', () => {
  it('buildOllamaToolPrompt produces readable tool definitions', () => {
    const prompt = buildOllamaToolPrompt([FIXTURE_TOOL]);
    expect(prompt).toContain('get_weather');
    expect(prompt).toContain('Get the current weather');
    expect(prompt).toContain('location');
    expect(prompt).toContain('JSON array');
  });

  it('parseOllamaToolResponse extracts tool calls from valid JSON', () => {
    const response = '[{"name": "get_weather", "arguments": {"location": "NYC"}}]';
    const calls = parseOllamaToolResponse(response);
    expect(calls).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls![0]!.name).toBe('get_weather');
    expect(calls![0]!.arguments).toEqual({ location: 'NYC' });
    expect(calls![0]!.id).toContain('ollama-tc-');
  });

  it('parseOllamaToolResponse handles multiple tool calls', () => {
    const response = '[{"name": "search", "arguments": {"query": "hello"}}, {"name": "get_weather", "arguments": {"location": "NYC"}}]';
    const calls = parseOllamaToolResponse(response);
    expect(calls).toHaveLength(2);
  });

  it('parseOllamaToolResponse returns null for plain text', () => {
    expect(parseOllamaToolResponse('The weather in NYC is 72°F.')).toBeNull();
  });

  it('parseOllamaToolResponse returns null for invalid JSON array', () => {
    expect(parseOllamaToolResponse('[not valid json')).toBeNull();
  });

  it('parseOllamaToolResponse returns null for non-array JSON', () => {
    expect(parseOllamaToolResponse('{"name": "test"}')).toBeNull();
  });

  it('round-trips Ollama tools: prompt → response → parse → result', () => {
    const prompt = buildOllamaToolPrompt(FIXTURE_TOOLS);
    expect(prompt).toContain('get_weather');
    expect(prompt).toContain('search');

    // Simulate model response
    const response = '[{"name": "get_weather", "arguments": {"location": "London"}}]';
    const calls = parseOllamaToolResponse(response);
    expect(calls).not.toBeNull();

    const resultMsg = buildOllamaToolResultMessage(calls![0]!.name, '15°C, Cloudy');
    expect(resultMsg.role).toBe('user');
    expect(resultMsg.content).toContain('get_weather');
    expect(resultMsg.content).toContain('15°C, Cloudy');
  });
});

// ── ollamaSupportsNativeTools ────────────────────────────────────────────────

describe('ollamaSupportsNativeTools', () => {
  it('recognizes known native-tool models', () => {
    expect(ollamaSupportsNativeTools('llama3.1:8b')).toBe(true);
    expect(ollamaSupportsNativeTools('qwen2.5:7b')).toBe(true);
    expect(ollamaSupportsNativeTools('mistral:latest')).toBe(true);
  });

  it('rejects unknown models', () => {
    expect(ollamaSupportsNativeTools('phi3:mini')).toBe(false);
    expect(ollamaSupportsNativeTools('gemma2:2b')).toBe(false);
  });
});

// ── Tool result message helpers ──────────────────────────────────────────────

describe('tool result messages', () => {
  it('buildToolResultMessage creates a standard tool message', () => {
    const msg = buildToolResultMessage('tc-1', 'search', 'Found 10 results');
    expect(msg.role).toBe('tool');
    expect(msg.tool_call_id).toBe('tc-1');
    expect(msg.name).toBe('search');
    expect(msg.content).toBe('Found 10 results');
  });

  it('buildOllamaToolResultMessage creates a user message', () => {
    const msg = buildOllamaToolResultMessage('search', 'Found 10 results');
    expect(msg.role).toBe('user');
    expect(msg.content).toContain('search');
    expect(msg.content).toContain('Found 10 results');
  });
});
