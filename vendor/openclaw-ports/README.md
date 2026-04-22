# OpenClaw Ports
Provenance tracker for every file copied or adapted from OpenClaw into Alduin.
Upstream: https://github.com/steipete/openclaw · LICENSE: MIT (see ./LICENSE)
Upstream SHA baseline: 778ac4330aa32b9ce4482f0d1a3d4f744ff7f17f

## File registry
| Helios path | Origin path (OpenClaw) | Origin SHA | Verbatim? | Notes |
|---|---|---|---|---|
| `packages/plugin-sdk/src/manifest.ts` | `src/plugin-sdk/plugin-entry.ts` | 778ac433 | No | Manifest shape adapted; OpenClaw's 80+ type exports replaced with 3-kind discriminated union |
| `packages/plugin-sdk/src/provider.ts` | `src/plugin-sdk/plugin-entry.ts` | 778ac433 | No | Provider plugin interface; LLM types are SDK-local (compatible with `src/types/llm.ts`) |
| `packages/plugin-sdk/src/skill.ts` | `src/agents/skills/frontmatter.ts` | 778ac433 | No | Skill plugin interface adapted from frontmatter schema |
| `src/plugins/types.ts` | `src/plugins/loader.ts` | 778ac433 | No | Internal types for loaded plugin state; host-side view only |
| `src/plugins/loader.ts` | `src/plugins/loader.ts` | 778ac433 | No | Plugin discovery + validation + entry loading; stripped channel/signed/hot-reload branches |
| `src/plugins/registry.ts` | `src/plugins/loader.ts` | 778ac433 | No | Runtime plugin registry; read-only view of loaded plugins |
| `plugins/builtin/anthropic/` | N/A | N/A | No | Builtin Anthropic provider plugin; wraps src/providers/anthropic.ts |
| `plugins/builtin/openai/` | N/A | N/A | No | Builtin OpenAI provider plugin; wraps src/providers/openai.ts |
| `plugins/builtin/openai-compatible/` | N/A | N/A | No | Builtin OpenAI-compatible provider plugin; wraps src/providers/openai-compatible.ts |
| `plugins/builtin/ollama/` | N/A | N/A | No | Builtin Ollama provider plugin; wraps src/providers/ollama.ts |
| `src/auth/profiles/types.ts` | `src/agents/auth-profiles/index.ts` | 778ac433 | No | Auth profile types; stripped OAuth flows |
| `src/auth/profiles/rotation.ts` | `src/agents/auth-profiles/rotation.ts` | 778ac433 | No | Priority + health + retry_after rotation engine |
| `src/auth/profiles/index.ts` | `src/agents/auth-profiles/index.ts` | 778ac433 | No | Profile manager; bridges rotator with CredentialVault |
| `src/skills/frontmatter.ts` | `src/agents/skills/frontmatter.ts` | 778ac433 | No | Frontmatter parser ported; schema adapted for Helios (model_hints, allow_sub_orchestration, sandbox flags); install-spec normalization removed |
