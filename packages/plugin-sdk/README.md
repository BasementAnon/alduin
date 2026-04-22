# @alduin/plugin-sdk

Public contract for Alduin plugins.  This package defines the types, Zod
schemas, and helpers that every Alduin plugin depends on.

**Stability commitment:** this is a forever-stable surface.  Breaking
changes require a major version bump.

## Plugin kinds

Alduin supports three plugin kinds.  Each declares itself with a
`alduin.plugin.json` manifest validated against the Zod schemas in this
package.

### 1. Provider plugin

Adds an LLM transport (OpenRouter, Together, Groq, LM Studio, etc.).

```jsonc
// alduin.plugin.json
{
  "id": "openrouter",
  "version": "0.1.0",
  "kind": "provider",
  "entry": "./dist/index.js",
  "providers": ["openrouter"],
  "providerAuthEnvVars": { "openrouter": ["OPENROUTER_API_KEY"] },
  "contributes": {
    "config_schema": "./schema.json",
    "models_catalog": "./models.json"
  }
}
```

```typescript
// src/index.ts
import { definePlugin, type ProviderPlugin, type PluginContext } from '@alduin/plugin-sdk';
import type {
  PluginLLMCompletionRequest,
  PluginLLMCompletionResponse,
  PluginLLMError,
  PluginResult,
} from '@alduin/plugin-sdk';

export const provider: ProviderPlugin = {
  id: 'openrouter',

  async complete(
    request: PluginLLMCompletionRequest,
    ctx: PluginContext,
  ): Promise<PluginResult<PluginLLMCompletionResponse, PluginLLMError>> {
    const apiKey = await ctx.getCredential('openrouter-api-key');
    if (!apiKey) return { ok: false, error: { type: 'auth', message: 'Missing API key', retryable: false } };

    // ... call the OpenRouter API ...

    return {
      ok: true,
      value: {
        content: 'Hello from OpenRouter!',
        usage: { input_tokens: 10, output_tokens: 5 },
        model: request.model,
        finish_reason: 'stop',
      },
    };
  },

  countTokens(_text: string): number {
    return 0; // Delegate to the catalog's tokenizer
  },
};

export default definePlugin({
  id: 'openrouter',
  version: '0.1.0',
  kind: 'provider',
  entry: './dist/index.js',
  providers: ['openrouter'],
});
```

### 2. Skill plugin

Installable workflow with frontmatter manifest.

```jsonc
// alduin.plugin.json
{
  "id": "code-review",
  "version": "0.1.0",
  "kind": "skill",
  "entry": "./dist/index.js",
  "skills": ["code-review"]
}
```

```typescript
// src/index.ts
import { definePlugin, type SkillPlugin, type SkillManifestEntry, type SkillDefinition, type PluginContext } from '@alduin/plugin-sdk';

export const skill: SkillPlugin = {
  id: 'code-review',

  getManifestEntries(): SkillManifestEntry[] {
    return [{
      id: 'code-review',
      description: 'Review a diff for correctness, style, and risks.',
      inputs: ['diff', 'style_guide?'],
      model_hints: {
        prefer: ['anthropic/claude-sonnet-4-6'],
        fallback_local: 'ollama/qwen2.5-coder:32b',
      },
    }];
  },

  getDefinition(skillId: string, _ctx: PluginContext): SkillDefinition | null {
    if (skillId !== 'code-review') return null;
    return {
      id: 'code-review',
      description: 'Review a diff for correctness, style, and risks.',
      inputs: ['diff', 'style_guide?'],
      model_hints: { prefer: ['anthropic/claude-sonnet-4-6'] },
      prompt: 'You are a senior code reviewer...',
      env_required: [],
      os: 'any',
      allow_sub_orchestration: false,
    };
  },
};

export default definePlugin({
  id: 'code-review',
  version: '0.1.0',
  kind: 'skill',
  entry: './dist/index.js',
  skills: ['code-review'],
});
```

### 3. Tool plugin

Callable from executors, implemented as an in-process MCP server.

```jsonc
// alduin.plugin.json
{
  "id": "calculator",
  "version": "0.1.0",
  "kind": "tool",
  "entry": "./dist/index.js",
  "tools": ["calculate"]
}
```

```typescript
// src/index.ts
import { definePlugin, type ToolPlugin, type ToolDescriptor, type ToolResult, type PluginContext } from '@alduin/plugin-sdk';

export const tool: ToolPlugin = {
  id: 'calculator',

  listTools(): ToolDescriptor[] {
    return [{
      name: 'calculate',
      description: 'Evaluate a mathematical expression.',
      inputSchema: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'The math expression to evaluate' },
        },
        required: ['expression'],
      },
    }];
  },

  async invoke(toolName: string, args: Record<string, unknown>, _ctx: PluginContext): Promise<ToolResult> {
    if (toolName !== 'calculate') return { ok: false, error: `Unknown tool: ${toolName}` };
    try {
      // (Use a safe math parser in production — never eval())
      return { ok: true, output: String(args['expression']) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};

export default definePlugin({
  id: 'calculator',
  version: '0.1.0',
  kind: 'tool',
  entry: './dist/index.js',
  tools: ['calculate'],
});
```

## API reference

### `definePlugin(manifest)`

Typed identity helper (like Vite's `defineConfig`).  Returns the manifest
unchanged; the generic constraint narrows `kind` for autocomplete.

### Manifest schemas (Zod)

All exported from `@alduin/plugin-sdk`:

- `alduinPluginManifestSchema` — discriminated union of all three kinds
- `providerManifestSchema`, `skillManifestSchema`, `toolManifestSchema`
- `pluginContributionSchema` — the `contributes` block

### Plugin interfaces

- `ProviderPlugin` — `complete()`, `countTokens()`, optional `streamComplete()`
- `SkillPlugin` — `getManifestEntries()`, `getDefinition()`
- `ToolPlugin` — `listTools()`, `invoke()`

### Context

- `PluginContext` — `log`, `getCredential()`, `getConfig()`
- `PluginLogger` — `info()`, `warn()`, `error()`, `debug()`
