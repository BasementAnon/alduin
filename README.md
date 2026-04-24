# Alduin

**Next-generation multi-model AI agent orchestrator.**

Alduin fixes the core architectural flaw in OpenClaw: the executing model decides whether to delegate, causing 50–80% missed delegations. Alduin separates THINKING from DOING — with recursive sub-orchestration, a plugin system, and runtime-tunable admin controls.

---

## Two-plane architecture

```
┌───────────────────────────────────────────────────────────────┐
│                     INTEGRATION PLANE                         │
│                                                               │
│  ┌─────────────┐   ┌──────────────┐   ┌─────────────────┐     │
│  │  Telegram   │   │ Slack (later)│   │ Discord (later) │     │
│  │  Adapter    │   │  Adapter     │   │  Adapter        │     │
│  └──────┬──────┘   └──────┬───────┘   └────────┬────────┘     │
│         └──────────┬──────┴────────────────────┘              │
│                    ▼                                          │
│  ┌────────────────────────────────────────────────────────┐   │
│  │  Webhook Gateway  │  Session Resolver  │  Auth/Policy  │   │
│  └─────────┬───────────────────────────────────┬──────────┘   │
│            ▼                                   │              │
│  ┌───────────────────┐                         │              │
│  │ Ingestion Pipeline│ (OCR/STT/URL/PDF)       │              │
│  └─────────┬─────────┘                         │              │
└────────────┼───────────────────────────────────┼──────────────┘
             │ NormalizedEvent + SessionId       │ Policy verdict
             ▼                                   ▼
┌───────────────────────────────────────────────────────────────┐
│                        RUNTIME PLANE                          │
│                                                               │
│  Pre-Classifier ──▶ Orchestrator ──▶ Executors ──▶ Memory     │
│       (cheap)       (plans; recursive)  (does)                │
│                         │    ↺              │                 │
│                         └── Event Bus ──────┘                 │
│                              │                                │
│  Plugin Host (MCP) ─── Skills Registry ─── Tool Registry      │
│                                                               │
└────────────────────────────────────────────────────────────-──┘
                               │ PresentationPayload
                               ▼
┌───────────────────────────────────────────────────────────────┐
│                      OUTBOUND RENDERER                        │
│  channel-neutral payload ──▶ per-channel native message(s)    │
│  (edits, streaming, buttons, files, typing indicators)        │
└───────────────────────────────────────────────────────────────┘
```

**Key principles:**
- The orchestrator **PLANS** but never executes. It emits structured JSON plans.
- Executors **DO** work and receive zero conversation history.
- The orchestrator can **recurse** — spawning child orchestrations with cheaper models for subtasks, with a configurable depth guard.
- A pre-classifier routes messages before the orchestrator sees them — cheap tasks skip planning entirely.
- Every LLM call uses a real tokenizer. No character-count heuristics for budgets.
- Plugins (providers, tools, skills) are loaded via an MCP-compatible host.

---

## Quickstart

> **Full setup guide:** [docs/QUICKSTART.md](docs/QUICKSTART.md)

```bash
npm install
npm link                 # makes the `alduin` command available globally
alduin build
alduin init              # interactive first-run wizard
```

The wizard (built with @clack/prompts, Ctrl-C at any step is safe):
1. **Channel** — Telegram or CLI-only; long-poll (dev) or webhook (prod)
2. **Tokens** — bot token written directly to the encrypted vault (never to disk unencrypted)
3. **Models** — orchestrator + classifier from the pinned catalog; pins validated
4. **Budget** — daily limit, warning threshold, optional per-model caps
5. **Self-test** — one classifier + one orchestrator round-trip; latency + cost reported

---

## Running

```bash
# Development (long-poll mode — no public URL needed)
alduin dev

# With Telegram (requires TELEGRAM_BOT_TOKEN in env)
TELEGRAM_BOT_TOKEN=<token> alduin dev:telegram

# Production (webhook mode — requires public HTTPS URL)
alduin build
node dist/cli.js --config config.yaml
```

**Production security:** The webhook gateway port should be firewalled to only accept traffic from your webhook provider's IP ranges (e.g. Telegram uses `149.154.160.0/20` and `91.108.4.0/22`). The gateway strips CORS headers so browsers cannot reach it. If you add an admin panel later, bind it to `127.0.0.1` on a separate port.

---

## CLI commands

```bash
alduin init             # first-run wizard
alduin config           # view/edit configuration
alduin doctor           # diagnose config issues (11 rules, auto-fix support)
alduin models sync      # probe provider /models APIs, show new/removed
alduin models diff      # compare current config pins vs. catalog
alduin models upgrade   # propose new pins, run smoke tests, apply
alduin skills list      # list available skills
alduin skills run <id>  # execute a skill in its configured isolation environment
```

Model versions are **never auto-upgraded**. All changes go through `alduin models upgrade` and are logged to `.alduin/audit.log`.

---

## In-chat admin commands

All admin commands require `owner` or `admin` role.

```
/alduin status                               bot uptime, budgets, active sessions
/alduin budget show                          current daily spend per model
/alduin budget set daily 25.00               set global daily budget
/alduin budget set warn 0.8                  set warning threshold (0–1)
/alduin budget set per_model gpt-4.1 3.50    set per-model daily cap
/alduin budget set user:alice 5.00           set per-user daily limit
/alduin policy show                          list active policy rules
/alduin policy allow write                   allow write executor
/alduin policy allow skill research          allow a skill
/alduin policy allow tool echo               allow a tool
/alduin policy deny connector google-cal     deny a connector
/alduin recursion on|off|status              toggle recursive sub-orchestration
/alduin trace <id|last>                      show trace (tree format for recursive)
/alduin models list                          show configured models
/alduin models sync                          sync model catalog
/alduin plugins list                         show installed plugins
/alduin plugins install <id>                 install a plugin
/alduin plugins remove <id>                  remove a plugin
/alduin connect <connector>                  link a service via OAuth
/alduin forget                               redact secrets from memory
```

User commands (any role):
```
/connect google-calendar                 link a service (DM OAuth flow)
/retry                                   retry last failed task
/trace last                              see last task's cost and steps
```

---

## Plugin system

Alduin uses a plugin architecture based on `@alduin/plugin-sdk`:

**Builtin providers** (loaded automatically):
- `anthropic` — Claude models with streaming
- `openai` — GPT models with streaming
- `ollama` — local models via Ollama
- `openai-compatible` — any OpenAI-compatible API

**Tool plugins:**
- `tool-echo` — echo tool for testing
- Custom tools loaded from `plugins/` directory

**Skills:**
- YAML frontmatter-based skill definitions in `skills/`
- Configurable per-skill permissions enforced by the policy engine
- Registry with frontmatter parsing and validation

Plugins are discovered via the MCP host (`src/plugins/mcp-host.ts`) which provides an in-process Model Context Protocol interface.

---

## Recursive orchestration

The orchestrator can delegate subtasks to child orchestrations:

```
Orchestrator (sonnet) ─── plans task
  ├── Executor: draft (qwen)
  ├── Sub-orchestrate (qwen) ─── plans subtask
  │     ├── Executor: research (haiku)
  │     └── Executor: summarize (haiku)
  └── Executor: synthesize (sonnet)
```

- **Depth guard** — configurable max recursion depth (default: 3)
- **Per-session toggle** — `/alduin recursion off` disables for the session
- **Tree traces** — `/alduin trace <id>` shows hierarchical cost/latency breakdown
- **Child prompts** — each child receives a scoped system prompt with parent context

---

## Architecture features

| Feature | Status |
|---------|--------|
| Telegram adapter (webhook + long-poll) | ✅ |
| CLI adapter | ✅ |
| Webhook gateway with sig verify + dedup | ✅ |
| Session resolver (SQLite) | ✅ |
| Ingestion pipeline (images, PDF, URL) | ✅ |
| Google Calendar connector | ✅ |
| Policy engine (YAML hot-reload) | ✅ |
| Per-user/group/model budgets (runtime-tunable) | ✅ |
| Model catalog with pinned versions | ✅ |
| Pre-classifier routing | ✅ |
| Orchestrator → executor dispatch | ✅ |
| Recursive sub-orchestration | ✅ |
| Plugin system (@alduin/plugin-sdk) | ✅ |
| MCP host (in-process) | ✅ |
| Skills registry + permissioned runner | ✅ |
| Provider streaming | ✅ |
| Tiered memory (hot/warm/cold) | ✅ |
| Deterministic pipeline engine | ✅ |
| Circuit breaker + fallback chains | ✅ |
| Event bus + streaming renderer | ✅ |
| First-run wizard (`alduin init`) | ✅ |
| Doctor (11 diagnostic rules, auto-fix) | ✅ |
| Credential vault (AES-256-GCM + OS keychain) | ✅ |
| Audit log (`.alduin/audit.log`) | ✅ |
| Auth-profile rotation | ✅ |
| Expanded admin commands (budget/policy/models/plugins) | ✅ |
| Slack adapter | ⏳ Deferred |
| Discord adapter | ⏳ Deferred |
| OpenClaw compatibility shim | ⏳ Deferred |
| Web admin panel | ⏳ Deferred |
| Signed skill marketplace | ⏳ Deferred |

---

## Configuration

Full documentation in `config.example.yaml`. Key sections:

- `catalog_version` — which catalog revision the model pins were validated against
- `orchestrator` — model + context budget for the planner
- `executors` — per-executor model + tool assignments
- `routing` — pre-classifier enable/disable + threshold
- `budgets` — global + per-model daily limits
- `channels.telegram` — long-poll vs. webhook mode
- `ingestion` — size gate, OCR/STT feature flags
- `memory` — hot/warm/cold tier config
- `plugins` — plugin directories and settings

---

## Testing

```bash
alduin test              # all 858 unit + integration tests
alduin test -- e2e       # end-to-end test (mocked providers)
alduin test:coverage
```

---

## Health check

```bash
alduin doctor         # runs 11 diagnostic rules
```

Rules checked: config-valid, catalog-version, models-exist, models-deprecated, schema-sync, env-overrides, dotenv-secrets, legacy-keys, dangling-refs, vault-encrypt, plugin-schema-drift. Auto-fix available for most warnings.

---

## License

Business Source License 1.1 — see [LICENSE](LICENSE) for details.
Converts to MIT four years after each version's release date.
