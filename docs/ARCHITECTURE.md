# Architecture

## Core Principle: Separation of Concerns

The orchestrator THINKS. The executors DO. These are never the same model. Executors may themselves spawn sub-orchestrators on **different** models (see §3 Recursive Multi-Model Orchestration); that is the mechanism by which Alduin keeps the thinking-vs-doing split while letting a cheap local model drive an expensive one, or vice versa.

Alduin has two planes:

- **Integration plane** — channels, connectors, ingestion, renderer, auth, session, config, plugin host. Everything outside the model loop. Most of this surface is adapted from OpenClaw (MIT) under `vendor/openclaw-ports/` with per-file attribution.
- **Runtime plane** — pre-classifier, orchestrator, executors, memory, pipelines, resilience, tracing. Everything inside the model loop. This is Alduin's original contribution and the reason the project exists: strict plan/do separation plus recursive multi-model routing.

The integration plane normalizes the world into `NormalizedEvent`s and feeds them to the runtime plane, which emits `PresentationPayload`s and `ExecutorEvent`s back out. The two planes share no types except those two message shapes and the session identity.

```
┌───────────────────────────────────────────────────────────────┐
│                     INTEGRATION PLANE                          │
│                                                               │
│  ┌─────────────┐   ┌──────────────┐   ┌─────────────────┐    │
│  │  Telegram   │   │ Slack (later)│   │ Discord (later) │    │
│  │  Adapter    │   │  Adapter     │   │  Adapter        │    │
│  └──────┬──────┘   └──────┬───────┘   └────────┬────────┘    │
│         └──────────┬──────┴─────────────────────┘            │
│                    ▼                                          │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Webhook Gateway  │  Session Resolver  │  Auth/Policy  │  │
│  └─────────┬───────────────────────────────────┬──────────┘  │
│            ▼                                   │              │
│  ┌───────────────────┐                         │              │
│  │ Ingestion Pipeline│ (media normalize,       │              │
│  │ (OCR/STT/URL)     │  virus/size gate)       │              │
│  └─────────┬─────────┘                         │              │
└────────────┼───────────────────────────────────┼──────────────┘
             │ NormalizedEvent + SessionId       │ Policy verdict
             ▼                                   ▼
┌───────────────────────────────────────────────────────────────┐
│                        RUNTIME PLANE                          │
│                                                               │
│  Pre-Classifier ──▶ Orchestrator ──▶ Executors ──▶ Memory    │
│                         │                │                    │
│                         └── Event Bus ───┘                    │
│                              │                                │
└──────────────────────────────┼────────────────────────────────┘
                               │ PresentationPayload + events
                               ▼
┌───────────────────────────────────────────────────────────────┐
│                      OUTBOUND RENDERER                         │
│  channel-neutral payload ──▶ per-channel native message(s)    │
│  (edits, streaming, buttons, files, typing indicators)        │
└───────────────────────────────────────────────────────────────┘
```

---

## Part 1: Integration Plane

### Channel Adapters

A `ChannelAdapter` is the only boundary between the outside world and Alduin.

```typescript
interface ChannelAdapter {
  id: string;                              // "telegram", "slack", "cli"
  capabilities: ChannelCapabilities;       // declarative feature flags
  start(): Promise<void>;                  // begin receiving events
  stop(): Promise<void>;
  send(payload: PresentationPayload,
       target: ChannelTarget): Promise<SentMessageRef>;
  edit(ref: SentMessageRef,
       payload: PresentationPayload): Promise<void>;
  onEvent(handler: (e: RawChannelEvent) => void): void;
}

interface ChannelCapabilities {
  supports_edit: boolean;
  supports_buttons: boolean;
  supports_threads: boolean;
  supports_files: boolean;
  supports_voice: boolean;
  supports_typing_indicator: boolean;
  max_message_length: number;
  max_attachment_bytes: number;
  markdown_dialect: 'telegram-html' | 'slack-mrkdwn' | 'discord-md' | 'commonmark' | 'plain';
}
```

**MVP ships with: Telegram (webhook + long-poll) and CLI.** Slack and Discord adapters exist as interface stubs only; wiring them is a future milestone and must not require changes to the runtime plane.

Every adapter normalizes inbound events into a single shape:

```typescript
interface NormalizedEvent {
  event_id: string;                        // idempotency key
  channel: string;
  received_at: string;                     // ISO 8601
  external: {
    thread_id: string;                     // e.g. Telegram chat_id
    user_id: string;
    user_handle?: string;
    is_group: boolean;
    message_id: string;
    edit_of?: string;                      // if this edits a prior message
  };
  kind: 'message' | 'callback' | 'edit' | 'file' | 'inline_query' | 'voice';
  text?: string;
  attachments?: AttachmentRef[];           // post-ingestion
  callback?: { payload: string; origin_ref: SentMessageRef };
  raw: unknown;                            // original payload, for trace
}
```

### Webhook Gateway

A single process-wide inbound gateway receives HTTP webhooks from all channels, verifies signatures, rate-limits per channel+user, deduplicates by `event_id`, and hands `RawChannelEvent`s to the matching adapter. Long-poll adapters (Telegram `getUpdates`) bypass HTTP but still dedupe through the same key.

### Session Resolver

Sessions are the durable identity that stitches the integration plane to the runtime plane.

```typescript
interface Session {
  session_id: string;                      // internal UUID
  channel: string;
  external_thread_id: string;              // Telegram chat_id, Slack channel, etc.
  external_user_ids: string[];             // multiple in group chats
  group_session_id?: string;               // set for group chats
  tenant_id: string;                       // org/deployment isolation
  created_at: string;
  last_active_at: string;
  policy_overrides?: PolicyOverrides;
}
```

Mapping is `(channel, external_thread_id) → session_id`. Group chats get a `group_session_id` plus per-user `sub_session_id` for private context (e.g. "my calendar" in a group chat resolves to that user's sub-session). Sessions persist in SQLite (local-first, like OpenClaw), with an indexed lookup table.

The session is the foreign key on: orchestrator conversation state, executor task lineage, memory tiers (hot/warm/cold/archive), trace records, and budget counters.

### Ingestion Pipeline

Raw attachments from channels are never passed directly to executors. They flow:

```
download → size/virus gate → content-type detect → blob store (TTL)
  → enrichment (OCR / STT / URL extract / EXIF strip) → AttachmentRef
```

```typescript
interface AttachmentRef {
  attachment_id: string;
  kind: 'image' | 'document' | 'audio' | 'voice' | 'video' | 'url';
  mime: string;
  bytes: number;
  storage_uri: string;                     // local blob path or s3:// etc.
  enrichment?: {
    ocr_text?: string;
    transcript?: string;
    extracted_title?: string;
    extracted_text?: string;
    page_count?: number;
  };
  ttl_expires_at: string;
}
```

Executors receive `AttachmentRef`s inside `input_data` and pull contents on demand. This keeps executor context small and lets the orchestrator reason about attachments without ever loading the raw bytes.

### Connectors (Third-Party App Framework)

Connectors are distinct from skills. A **skill** is a capability (summarize, generate code). A **connector** is an authenticated link to an external service (Google Calendar, GitHub, Gmail). Skills *use* connectors.

```typescript
interface Connector {
  id: string;                              // "google-calendar"
  version: string;
  auth: {
    kind: 'oauth2' | 'api_key' | 'none';
    scopes?: string[];
    token_refresh?: () => Promise<void>;
  };
  webhooks?: WebhookSubscription[];
  actions: Record<string, ConnectorAction>;// typed surface
  health(): Promise<ConnectorHealth>;
}
```

Credentials live in a separate `CredentialVault` backed by SQLite + OS keychain (macOS Keychain, libsecret on Linux, DPAPI on Windows). Connectors never read credentials from env or YAML directly — they request them from the vault at call time. This is a deliberate departure from OpenClaw, where credentials tend to leak into skill definitions.

Account linking uses a DM-based flow in MVP: user sends `/connect google-calendar` → bot replies with a one-time OAuth URL → callback lands on the webhook gateway → token stored in vault scoped to `session.tenant_id + user_id`.

### Auth & Policy

A policy engine sits between the session resolver and the runtime plane. Every `NormalizedEvent` is tagged with a **policy verdict** before it reaches the pre-classifier.

```typescript
interface PolicyContext {
  channel: string;
  tenant_id: string;
  user_id: string;
  user_role: 'owner' | 'admin' | 'member' | 'guest';
  is_group: boolean;
  session_id: string;
}

interface PolicyVerdict {
  allowed: boolean;
  denied_reason?: string;
  allowed_skills: string[];                // whitelist, or ['*']
  allowed_connectors: string[];
  allowed_executors: string[];
  cost_ceiling_usd: number;                // per-turn
  model_tier_max: 'local' | 'cheap' | 'standard' | 'frontier';
  requires_confirmation: string[];         // actions needing /confirm
}
```

Defaults: group chats deny writes (email send, file delete, etc.) unless the group owner has run `/alduin policy allow write` for that group. The policy file is hot-reloadable and versioned; runtime edits via admin DM commands are written back to the file with an audit entry.

### Event-Driven Executor Protocol

The executor contract is extended from request/response to request + event stream + terminal result.

```typescript
interface ExecutorEvent {
  task_id: string;
  session_id: string;
  step_index: number;
  kind: 'progress' | 'partial' | 'needs_input' | 'artifact' | 'tool_call';
  data: unknown;
  emitted_at: string;
}
```

A per-session event bus (in-process pub/sub, backed by SQLite for durability) carries these to:

- the **orchestrator**, which may replan on `needs_input`,
- the **renderer**, which streams progress to the channel (typing indicators, message edits, incremental replies).

The terminal `ExecutorResult` shape is unchanged. This preserves backward compat with existing executors while unlocking streaming, callbacks, and long-running async workflows.

### Outbound Renderer

Results are rendered through a channel-neutral payload.

```typescript
interface PresentationPayload {
  session_id: string;
  origin_event_id?: string;                // for edit-in-place
  blocks: PresentationBlock[];
  followups?: FollowupButton[];
  files?: AttachmentRef[];
  status?: 'in_progress' | 'complete' | 'failed' | 'partial' | 'needs_input';
  meta?: { trace_id?: string; cost_usd?: number };
}

type PresentationBlock =
  | { kind: 'text'; text: string }
  | { kind: 'markdown'; md: string }
  | { kind: 'code'; lang: string; source: string }
  | { kind: 'card'; title: string; body: string; fields?: KV[] }
  | { kind: 'progress'; label: string; pct?: number }
  | { kind: 'quote'; text: string; cite?: string };
```

Each adapter owns a `render(payload) → channel-native message(s)` implementation. Telegram's renderer handles: markdown→Telegram-HTML sanitization, chunking at 4096 chars, inline keyboard construction, file upload sizing, and edit-in-place when `supports_edit` and `origin_event_id` is present.

### Async Job Reconciliation

Long-running pipelines emit events keyed to `(session_id, origin_event_id)`. The renderer's reconciliation strategy, in priority order:

1. **Edit in place** — if channel supports edits and the original message is still within the edit window.
2. **Threaded reply** — if the channel supports threads.
3. **New message with quoted reference** — fallback.

Failure and partial-success always render *something* — silent timeouts are a bug. A dedicated `status: 'failed'` payload explains what went wrong in user-friendly terms (not stack traces) and offers `/retry`, `/trace`, or `/cancel` followups.

### OpenClaw Code Provenance

Alduin's integration plane (config, secrets, plugin host, skill frontmatter, auth profiles, wizard, terminal helpers, doctor) is adapted from OpenClaw (MIT, © Peter Steinberger). There is **no live upstream dependency** — OpenClaw is the parts donor, not a library. The port lives in two places:

- `vendor/openclaw-ports/` — verbatim copies with minimal patches. Each file carries a provenance header listing the source path and SHA. `vendor/openclaw-ports/LICENSE` holds the OpenClaw MIT notice.
- `src/` — adapted modules with a file-level attribution header pointing back at the vendor dir.

The earlier "OpenClaw compatibility shim" idea (import OpenClaw skills at runtime) is dropped. Skills are either re-authored as Alduin skills or left behind; there is no runtime bridge.

---

## Part 2: Runtime Plane

### Pipeline

```
NormalizedEvent ──▶ Pre-Classifier ──▶ [simple → Quick Executor]
                                    └──▶ [complex → Orchestrator ──▶ Executors]
                                                                 │
                                                                 ▼
                                                        Event Bus ──▶ Renderer
```

### Pre-Classifier Layer

Cheap/fast model (Haiku, local 7B). Input is the message only, no history, no tools. Output is strict JSON:

```typescript
interface ClassificationResult {
  complexity: 'low' | 'medium' | 'high';
  category: 'code' | 'research' | 'content' | 'ops' | 'conversation';
  suggested_executor: string;
  needs_orchestrator: boolean;
  confidence: number;                      // 0–1
}
```

Simple + high-confidence routes straight to the Quick Executor. Everything else goes to the orchestrator.

### Orchestrator

Plans task decomposition, selects executors, synthesizes results, and maintains conversation state. It never writes code, researches, or generates content itself.

```typescript
interface OrchestratorPlan {
  reasoning: string;
  steps: Array<{
    step_index: number;
    executor: string;
    instruction: string;
    depends_on: number[];
    input_from?: number;
    estimated_tokens: number;
  }>;
  estimated_total_cost: number;
  can_parallelize: boolean;
}
```

Steps are topologically sorted by `depends_on`. Independent steps run via `Promise.allSettled` with a concurrency limit.

### Executor Protocol

```typescript
interface ExecutorTask {
  id: string;
  session_id: string;                      // NEW: ties to integration plane
  executor_name: string;
  instruction: string;
  input_data?: string;
  attachments?: AttachmentRef[];           // NEW: from ingestion pipeline
  max_tokens: number;
  timeout_ms: number;
  tools: string[];
  return_format: 'summary' | 'full' | 'file_ref';
  metadata: {
    parent_task_id?: string;
    step_index?: number;
    pipeline_id?: string;
    policy_verdict: PolicyVerdict;         // NEW: carried through
  };
}

interface ExecutorResult {
  task_id: string;
  session_id: string;
  executor_name: string;
  status: 'complete' | 'failed' | 'timeout' | 'budget_exceeded' | 'policy_denied';
  summary: string;                         // max 500 tokens
  full_output?: string;
  artifacts?: string[];
  error?: { type: string; message: string; user_message: string };
  usage: { input_tokens: number; output_tokens: number; cost_usd: number; latency_ms: number };
}
```

Executors also emit `ExecutorEvent`s (see Integration Plane / Event-Driven Executor Protocol).

Executors receive ZERO conversation history. They get a task, they do it, they return a result.

### Context Management

**Orchestrator context (kept lean, ~9K tokens):**

```
System prompt (fixed, cached)           ~2K
Conversation summary (warm memory)      ~2K
Last 3 user/assistant turns (hot)       ~3K
Active task state (structured JSON)     ~1K
Available executor + skill manifest     ~1K
```

**Executor context (task-scoped, ~1K + data).**

### Memory Tiers

| Tier | Storage | TTL | When Loaded |
|------|---------|-----|-------------|
| Hot | In-context (last 3 turns) | Current session | Always |
| Warm | Rolling summary string | Current session | Always |
| Cold | Vector store (embeddings) | Permanent | Only on context-reference phrases |
| Archive | JSONL on disk | Permanent | Never auto-loaded |

All tiers are keyed by `session_id` — the integration plane's durable identity. Cold memory is queried only when the context-reference detector fires ("remember when," "like before," "we discussed").

### Skills (frontmatter + lazy loading + curated bundle)

A skill is a markdown file with YAML frontmatter plus an optional code module:

```markdown
---
id: code-review
description: Review a diff for correctness, style, and risks.
inputs: [diff, style_guide?]
model_hints: { prefer: ["anthropic/claude-sonnet-4-6", "openai/gpt-5"], fallback_local: "ollama/qwen2.5-coder:32b" }
env_required: []
os: any
allow_sub_orchestration: false
---

You are a senior code reviewer… (prompt body)
```

The orchestrator sees only a **compact manifest** (~100 tokens each): `id`, `description`, `inputs`, `model_hints`. Full definitions load into executor context on demand. 30 skills × ~500 tokens each = 15 K tokens saved per orchestrator call.

MVP ships a curated bundle of 6: `summarize`, `research`, `code-review`, `plan`, `extract`, `rewrite`. Users author their own or install signed skills via `alduin skills add`. Skill frontmatter and registry are adapted from OpenClaw with attribution.

### Deterministic Pipelines

For repeatable workflows the orchestrator builds a pipeline definition once, then a lightweight deterministic step runner executes it mechanically. No LLM tokens on orchestration after the initial plan. Supports parallel branches, conditional stops, iteration.

### Resilience

**Circuit breaker per provider.** CLOSED → (3 failures) → OPEN → (5 min) → HALF_OPEN → (test succeeds) → CLOSED. When OPEN, calls route to the fallback chain.

**Fallback chains.** Each model alias has an ordered fallback list. On rate-limit/timeout/circuit-open, the next alias is tried. The actual model used is logged.

---

## Part 3: Recursive Multi-Model Orchestration

The flagship differentiator. Executors can spawn sub-orchestrators on different models, under hard guards. Three canonical patterns:

1. **API plans → local executes → API synthesizes.** Sonnet orchestrates, Ollama/MLX 70B drafts, Sonnet polishes. Cheap for long generations; keeps quality on the entry/exit ends.
2. **Local plans → API handles one hard step → local synthesizes.** A 7B local model decomposes a largely mechanical workflow, dispatches one reasoning-heavy step to Sonnet/Opus, and finishes locally. Cheap when only one step actually needs a frontier model.
3. **Meta-prompting.** API orchestrator writes a tuned system prompt and input-shape for each local executor step. Dramatically lifts small-model quality without burning API tokens on the generation itself.

### Protocol extensions

```typescript
interface ExecutorTask {
  // … existing fields
  orchestration?: {
    allow_sub_orchestration: boolean;       // default false; opt-in per skill/executor
    max_depth: number;                      // default 2, hard cap 4
    parent_task_id?: string;
    parent_depth: number;                   // 0 at top level
    parent_budget_remaining_usd: number;    // flows down the tree
    allow_same_model_recursion?: boolean;   // default false
  };
}

interface ExecutorResult {
  // … existing fields
  sub_orchestration?: {
    child_plan_id: string;
    child_steps_executed: number;
    child_cost_usd: number;
  };
}
```

### Guards

- **Depth cap.** Hard max 4; default 2. A task at depth N can only spawn at N+1 if `allow_sub_orchestration` and `max_depth > N`.
- **Budget flow-through.** Parent's remaining cost ceiling becomes child's ceiling. Child cannot exceed. Spent funds are deducted from the parent's trace on child return.
- **Model affinity.** Child must run on a different model than its parent unless `allow_same_model_recursion: true` (rare — e.g. local→local with different system prompts for a critic pass).
- **Loop detection.** Every sub-orchestration edge records `(parent_model, child_model, hash(instruction))`. Repeated edges within a turn abort with `status: 'loop_detected'`.
- **Wall-clock ceiling.** Child inherits parent's remaining timeout budget.
- **Kill switch.** Admin command `/alduin recursion off` hard-disables sub-orchestration for the rest of the session, all scopes.

### Meta-prompting helper

`src/orchestrator/prompts.ts` exposes `writeChildSystemPrompt(parentModel, childModel, instruction)` which an orchestrator can call deterministically (no extra LLM burn) or LLM-assisted (one extra call, amortized across multiple child steps). When the child is a small local model, the helper adds few-shot examples, explicit output schemas, and guard rails that the parent model would not need for itself.

### Tracing

Every child call logs `parent_task_id`, `depth`, and the cost delta against the parent. The `/trace` command returns a tree rather than a flat list when recursion occurred. Budget dashboards attribute spend to the **root** task so a recursive turn's total cost is visible at a glance.

### Default posture

Recursive orchestration is **off by default**. Executors and skills opt in explicitly in their manifest. A single recursion edge requires explicit audit in the skill's manifest and is surfaced in `alduin doctor` so operators can see at a glance which skills can recurse and on what model pair.

---

## Part 4: Plugin Architecture

Alduin is a plugin host. The core stays lean; capability ships as plugins — even bundled ones. Adapted from OpenClaw's `plugin-sdk` + loader.

### Three plugin kinds

1. **Provider plugins** — add an LLM transport. Used for OpenRouter, Together, Groq, LM Studio, llama.cpp, MLX, and any custom API. Contributes models to the catalog and declares tokenizer/pricing metadata.
2. **Skill plugins** — installable workflows. A skill is a markdown file with YAML frontmatter (id, description, inputs, model hints, env/OS gates) plus an optional code module.
3. **Tool plugins** — callable from executors. Implemented as MCP servers hosted in-process by Alduin's MCP adapter. Not an external `mcporter`-style subprocess.

### Manifest

Plugins declare themselves with `alduin.plugin.json`:

```json
{
  "id": "openrouter",
  "version": "0.1.0",
  "kind": "provider",
  "entry": "./dist/index.js",
  "providers": ["openrouter"],
  "providerAuthEnvVars": { "openrouter": ["OPENROUTER_API_KEY"] },
  "contributes": {
    "config_schema": "./schema.json",
    "config_hints": "./hints.json",
    "models_catalog": "./models.json"
  }
}
```

A plugin's contributed config schema is merged into `src/config/schema.generated.ts` at install/build time. CI and `alduin doctor` both run the drift check; a plugin installation that would break an existing user's config is refused.

### SDK

`packages/plugin-sdk/` exposes a minimal public contract — `ProviderPlugin`, `SkillPlugin`, `ToolPlugin` entry types plus their manifest Zod schemas. This is a forever-stable surface; breaking changes require a major version.

### Loader

`src/plugins/loader.ts` handles npm resolution, manifest validation, hot-reload (dev), and signed-manifest verification (prod). Plugins never modify Alduin's process state; they register via callbacks passed at init.

### Built-in providers as plugins

`anthropic`, `openai`, `openai-compatible` (DeepSeek, Fireworks, Groq via base-URL override), and `ollama` are packaged as plugins in-tree under `plugins/builtin/` but still go through the manifest pipeline — so a third-party provider has exactly the same surface as a built-in one.

---

## Part 5: Model Catalog (Pinned-Only, Explicit Upgrade)

**Design constraint: safety over convenience.** Model versions are never auto-upgraded. Config pins exact versions. Upgrades are an explicit, reviewable action.

### Why a catalog exists

Today, pricing and tokenizer choice are hardcoded in `src/providers/*.ts` (e.g. `anthropic.ts` sets `claude-sonnet-4-6` input/output prices). When a provider ships a new version, those constants rot. The catalog moves all per-model metadata out of code and into a single source of truth.

### Catalog shape

`models.catalog.json` (ships with the app, versioned, signed):

```json
{
  "catalog_version": "2026-04-14",
  "models": {
    "anthropic/claude-sonnet-4-6": {
      "provider": "anthropic",
      "api_id": "claude-sonnet-4-6",
      "released": "2026-02-10",
      "status": "stable",
      "context_window": 200000,
      "max_output_tokens": 64000,
      "tokenizer": "anthropic",
      "pricing_usd_per_mtok": { "input": 3, "output": 15 },
      "capabilities": ["tool_use", "vision", "streaming"],
      "deprecated": false,
      "sunset_date": null
    },
    "openai/gpt-4.1": { "...": "..." }
  }
}
```

### Resolution sources, in priority order

1. **Provider `/models` endpoints** (OpenAI `/v1/models`, Anthropic `/v1/models`, Ollama `/api/tags`, DeepSeek `/models`) — used only to *discover* new versions and to validate that pinned versions still exist.
2. **Shipped catalog file** (`models.catalog.json`) — source of truth for pricing, context window, tokenizer, capabilities.
3. **Local override** (`models.override.yaml`) — for air-gapped, custom, or private deployments.

### Config references versions, not aliases

Config files specify exact pinned versions. No `@latest`, no `@stable`:

```yaml
orchestrator:
  model: anthropic/claude-sonnet-4-6      # exact pin, required
```

A `catalog_version` field in the config records which catalog revision the pins were validated against. Startup validates every referenced model exists in the catalog and is not marked `deprecated` — deprecation emits a warning, sunset emits an error.

### Upgrade command

Upgrades are never automatic. The operator runs:

```
alduin models sync         # pull latest catalog + discover new provider versions
alduin models diff         # show what changed vs. current pins
alduin models upgrade [--dry-run] [--model anthropic/claude-sonnet]
  # 1. Proposes new pins based on provider 'latest stable' signals
  # 2. Runs compatibility smoke tests against each proposed pin
  # 3. Diffs pricing and context-window changes
  # 4. Prompts for confirmation
  # 5. Writes new pins to config.yaml with a version-control-friendly diff
  # 6. Emits audit log entry
```

Dry-run prints the proposed diff without touching files. This is the only path that mutates pinned model versions.

### Fail-safe behavior

- Catalog refresh failures → last-known-good cached catalog is used; startup warns.
- Pinned model missing from catalog → startup error; operator must run `alduin models sync` or pin something else.
- Pricing data missing → budget enforcement refuses to run (fail closed, not open).

### Pricing stays out of code

All `setPricing(...)` calls in `src/providers/*.ts` are removed. Providers become dumb transport; the catalog is queried for pricing and tokenizer choice at call time. This is a breaking change to the current provider layer and is tracked as an explicit refactor task.

---

## Part 6: UX Commitments (Better Than OpenClaw)

The integration plane isn't enough — OpenClaw's real friction is operational UX. Alduin commits to:

### Layered config (YAML canonical, env + vault overlays)

`config.yaml` is canonical and schema-validated. At load time three overlays compose onto it:

1. **Env-var path overrides.** `ALDUIN_ORCHESTRATOR__MODEL=anthropic/claude-opus-4-6` traverses the config tree via `__`-separated keys and overrides that single field. Scoped per process; useful for CI, containers, A/B tests.
2. **`SecretRef` resolution.** Fields typed `SecretInput` accept either a literal (discouraged) or `{ secret: "anthropic-api-key" }`, which resolves against the encrypted `CredentialVault` at call time. Keys never appear in YAML or logs.
3. **Admin DM writes.** `/alduin policy allow …`, `/alduin budget set …` round-trip through schema validation and write back to `config.yaml` with an audit entry.

The Zod schema is split per-domain (`src/config/schema/{models,providers,channels,agents,secrets}.ts`) and composed in `src/config/schema/index.ts`. A companion `src/config/schema-hints.ts` carries UI metadata (label, help, `sensitive`, `advanced`) that a future Control UI consumes without reintroducing schema introspection.

Plugins contribute schema via their manifests; the merged result is frozen into `src/config/schema.generated.ts`. CI and `alduin doctor` both run a drift check — a plugin install that breaks existing config is refused before it can corrupt a running deployment.

`.env` holds only the bootstrap secrets needed to unlock the vault on first run; after `alduin init` migrates them, `.env` is expected to be empty or absent.

### First-run wizard

`alduin init` walks through: (1) pick primary channel (Telegram at MVP), (2) paste bot token, (3) link one connector (Google Calendar by default), (4) set daily budget, (5) send a self-test message end-to-end. Wizard writes `config.yaml` and seeds the credential vault.

### Credentials never in source

All tokens, keys, and OAuth refresh tokens live in the `CredentialVault` (SQLite + OS keychain). Skill and connector code requests credentials by handle; it never sees them as literals.

### Renderer-owned formatting

Telegram's markdown quirks are a notorious OpenClaw pain point. Alduin centralizes all formatting in the renderer: one place to fix, one set of tests to run. Skills emit `PresentationBlock`s; they do not emit channel-specific strings.

### Always-visible status

- Typing indicator within 500 ms of receiving a message.
- Progress edits on any task taking > 3 s (`PresentationBlock.progress`).
- Explicit user-facing messages on budget hit, permission denied, or failure — never silent.
- `/trace` command returns a human-readable plan + costs for the last turn.

### Skill marketplace CLI

```
alduin skills search <query>
alduin skills add <name>          # signed manifest, permissioned install (worker-isolated, not a security boundary)
alduin skills update [<name>]     # gated on compat smoke tests
alduin skills remove <name>
```

### Admin commands in chat

`/alduin budget`, `/alduin policy`, `/alduin trace <id>`, `/alduin connect <app>`, `/alduin models` — all available in-channel so the operator never has to SSH to the host.

### Per-user and per-group budgets

Budgets are enforced at three scopes: global, group, user. OpenClaw only has global.

---

## Token Counting

All token counting uses real tokenizers, selected per the catalog's `tokenizer` field:

- `@anthropic-ai/tokenizer` for Anthropic-family models
- `tiktoken` (`cl100k_base` or `o200k_base` as specified) for OpenAI-family models
- Tokenizer name lookup from the catalog — no hardcoded defaults

Character-count heuristics are never used for budget enforcement.

## Observability

Every LLM call is traced with: task ID, session ID, model (pinned version actually used after any fallback), tokens in/out, cost USD, latency ms, executor name, step index, channel, tenant, trace ID.

```
Session: tg:chat:-100123 | User: @alice
Task: "Build a login page"
Steps: classify(0.2s,$0) → plan(1.1s,$0.004) → generate(3.1s,$0.018) → review(4.7s,$0.082)
Total: $0.10 | 12,436 tokens | 9.1s | trace=abc123
```

Budget enforcement is proactive: warning at 80%, hard stop at limit. Per-model, per-user, per-group, and global daily limits are independently tracked.

---

## File Structure

```
src/
  # Integration plane (NEW)
  channels/
    adapter.ts                # ChannelAdapter interface, capabilities
    telegram/
      index.ts                # MVP: webhook + long-poll
      renderer.ts             # markdown→Telegram-HTML, chunking
      capabilities.ts
    cli/                      # MVP
    slack/                    # stub only
    discord/                  # stub only
  webhooks/
    gateway.ts                # signature verify, dedupe, rate-limit
    routes.ts
  session/
    resolver.ts               # (channel,thread,user) → session_id
    store.ts                  # SQLite
    types.ts
  ingestion/
    pipeline.ts               # download→gate→detect→enrich
    blob-store.ts
    enrichers/
      ocr.ts
      stt.ts
      url-extract.ts
  connectors/
    framework.ts              # Connector interface
    oauth.ts
    google-calendar/          # MVP reference connector
  secrets/                    # REPLACES connectors/vault.ts
    vault.ts                  # AES-256-GCM + OS keychain
    ref.ts                    # SecretRef type + resolver
    migrate.ts                # import .env → vault on first run
  renderer/
    presentation.ts           # PresentationPayload, blocks
    reconcile.ts              # edit-in-place vs thread vs new
  auth/
    policy.ts
    roles.ts
    profiles/                 # NEW — ported auth-profile rotation
  bus/
    event-bus.ts              # in-proc pub/sub + SQLite durability
  plugins/                    # NEW — plugin host (Part 4)
    loader.ts
    registry.ts
    manifest-schema.ts

  # Runtime plane (existing, with catalog refactor + recursion)
  providers/                  # dumb transport only; no pricing
    anthropic.ts
    openai.ts
    ollama.ts
    openai-compatible.ts
    base.ts
    registry.ts
    discovery.ts              # NEW — Ollama/LM Studio runtime discovery
    compat.ts                 # NEW — tool-use normalization across providers
    streaming.ts              # NEW — per-provider streaming adapters
  catalog/                    # NEW
    catalog.ts                # load, validate, query
    sync.ts                   # alduin models sync
    upgrade.ts                # alduin models upgrade
    models.catalog.json
  tokens/
    counter.ts                # tokenizer from catalog
    budget.ts
  config/
    schema/                   # split per-domain (ported from OpenClaw)
      index.ts
      models.ts
      providers.ts
      channels.ts
      agents.ts
      secrets.ts
    schema-hints.ts           # NEW — UI metadata for Control UI
    schema.generated.ts       # NEW — auto-composed; CI drift-check
    env-overrides.ts          # NEW — ALDUIN_*__* path traversal
    loader.ts                 # extended — merge YAML + env + vault refs
    types.ts
  types/
    llm.ts
    result.ts
  orchestrator/
    loop.ts
    planner.ts
    synthesizer.ts
    context.ts
    prompts.ts                # extended — writeChildSystemPrompt()
    recursion.ts              # NEW — depth, loop detection, budget flow
  executor/
    dispatch.ts               # extended — propagates `orchestration` field
    sandbox.ts
    summarizer.ts
    types.ts
  router/
    classifier.ts
    rules.ts
    types.ts
  memory/
    hot.ts
    warm.ts
    cold.ts
    manager.ts
    detector.ts
  skills/
    registry.ts               # lazy-loading, compact manifest
    frontmatter.ts            # NEW — ported from OpenClaw
    sandbox.ts                # worker-thread isolation (MVP)
  pipeline/
    engine.ts
    types.ts
    templates.ts
  resilience/
    circuit-breaker.ts
    fallback.ts
  trace/
    logger.ts
    types.ts
  dashboard/
    reporter.ts
    cli-ui.ts
  cli.ts
  cli/
    wizard/                   # REPLACES init.ts — @clack/prompts flow
      index.ts
      steps/
        pick-channel.ts
        paste-tokens.ts
        pick-models.ts
        budget.ts
        self-test.ts
    config.ts                 # NEW — `alduin config get/set`
    doctor.ts                 # NEW — `alduin doctor` with auto-fix
    models.ts                 # models sync / diff / upgrade
    skills.ts                 # skills search / add / update / remove
    plugins.ts                # NEW — plugins list / install / remove
  util/
    table.ts                  # NEW — ported ANSI-safe table

packages/
  plugin-sdk/                 # NEW — public plugin contract
    src/
      index.ts
      provider.ts
      skill.ts
      tool.ts
      manifest.ts

plugins/
  builtin/                    # providers packaged as plugins, in-tree
    anthropic/
    openai/
    openai-compatible/
    ollama/

skills/                       # NEW — curated bundle
  summarize/
  research/
  code-review/
  plan/
  extract/
  rewrite/

vendor/
  openclaw-ports/             # NEW — verbatim copies, provenance tracked
    README.md                 # file, origin, SHA, modifications
    LICENSE                   # OpenClaw MIT notice
```

## MVP Scope

**In:** Telegram adapter (webhook + long-poll), CLI adapter, webhook gateway, session resolver, ingestion pipeline (images + documents; voice optional), one reference connector (Google Calendar), auth/policy with file + in-chat admin commands, event bus, renderer with Telegram dialect, async reconciliation, model catalog with pinned-only config + `alduin models` commands, layered config (YAML + env overrides + SecretRef vault), plugin host with built-in providers as plugins, curated skill bundle (6 skills), first-run wizard, per-user/group/global budgets, `/trace` and `/alduin *` in-chat commands, streaming per provider, tool-use compat across providers, **recursive multi-model orchestration** (off by default, opt-in per skill, depth-capped, budget-flowed, loop-detected), `alduin doctor`.

**Out (deferred):** Slack adapter, Discord adapter, web Control UI, third-party skill marketplace (beyond local-file install), subprocess-level skill sandboxing, dynamic mid-turn model hand-off (we commit to full recursive orchestration via child tasks, not stream-swap), OpenClaw runtime compatibility shim (skills are re-authored, not imported). Interfaces and module stubs are reserved so these are additive later, not reshaping.

---

