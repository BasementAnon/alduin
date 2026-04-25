# Quickstart

Get Alduin running in under 5 minutes.

## Prerequisites

- **Node.js 22+** — check with `node -v`
- **npm 10+** — ships with Node 22
- At least one provider API key (Anthropic, OpenAI, or DeepSeek)
- Optional: [Ollama](https://ollama.com) for local models

## 1. Clone, install, and build

```bash
git clone https://github.com/BasementAnon/alduin.git
cd alduin
npm install
npm run build
```

`npm run build` compiles TypeScript to `dist/`, makes the build artifacts executable, and symlinks the `alduin` command onto your global PATH via `npm link`. After this step, `alduin <command>` works from anywhere — no shell-config changes required.

> **If auto-linking fails:** on a system-managed Node install that requires `sudo` to write to the global prefix, the build will print a warning and skip the link. In that case you can still run the CLI as `./alduin <command>` from the project root, or retry once with `sudo npm link`. All examples below also work as `./alduin <command>` if you prefer not to link.

## 2. Run the setup wizard

```bash
alduin init
```

That's it. The wizard handles everything interactively — no need to manually edit `.env` or `config.yaml`. It walks you through 10 steps:

| Step | What it does |
|------|-------------|
| **0. Prerequisites** | Verifies Node ≥ 22, dependencies installed, build is current |
| **1. Welcome** | Detects existing config, offers fresh install or reconfigure |
| **2. Providers** | Multi-select LLM providers, enter API keys (encrypted in vault), test connectivity |
| **3. Models** | Assign models per role (orchestrator, classifier, executors) — fast-track defaults or customize each |
| **4. Budget** | Daily spend limit, per-task limit, warning threshold, optional per-model caps |
| **5. Channel** | CLI / Telegram / Both — validates bot token via getMe, uses long-poll automatically, sets up user allowlist |
| **6. Skills** | Enable/disable curated skills (research, code-review, summarize, etc.) |
| **7. Owner** | Seeds the first admin owner for Telegram commands |
| **8. Self-test** | Round-trip LLM calls with latency and cost report |
| **9. Summary** | Review all choices, confirm, write config atomically |

You can Ctrl-C at any step safely — no partial config is written until you confirm in Step 9. API keys are stored in the encrypted vault, never as plaintext on disk.

> **New to the Orchestrator / Classifier / Executor model?** Read [CONCEPTS.md](CONCEPTS.md) before Step 3 — it explains what each role does, why they're separate, and which model tier to assign to each one.

## 3. Start Alduin

```bash
alduin start
```

This boots the full runtime — providers, session store, policy engine, Telegram long-poll, and the webhook gateway. No public URL or firewall configuration required.

**Development (CLI REPL only — no Telegram):**

```bash
alduin dev
```

**Restart after config changes:**

```bash
alduin restart gateway
```

## 4. Verify your setup

Run the built-in diagnostics:

```bash
alduin doctor
```

Doctor checks 11 rules: config validity, catalog version, model existence, schema sync, env overrides, vault encryption, plugin integrity, and more. Most warnings have auto-fix support.

## Project structure

```
alduin/
├── src/                    # Source code
│   ├── orchestrator/       # Planning + recursive sub-orchestration
│   ├── executor/           # Task execution (no conversation history)
│   ├── channels/           # Telegram, CLI adapters
│   ├── config/             # Layered YAML + env-var config
│   ├── plugins/            # Plugin loader, registry, MCP host
│   ├── skills/             # Frontmatter-based skill engine
│   ├── memory/             # Hot/warm/cold tiered memory
│   ├── auth/               # Policy engine, audit log, profiles
│   ├── secrets/            # AES-256-GCM encrypted vault
│   └── cli/                # Wizard, doctor, config, skills commands
├── plugins/builtin/        # Built-in provider plugins
├── packages/plugin-sdk/    # @alduin/plugin-sdk for custom plugins
├── skills/                 # Curated skill definitions
├── config.example.yaml     # Full config template
└── docs/
    ├── ARCHITECTURE.md     # System design deep-dive
    └── QUICKSTART.md       # You are here
```

## Common commands

After `npm run build`, use `alduin <command>` from anywhere (or `./alduin <command>` from the project root if the auto-link step was skipped):

```bash
alduin init                # first-run wizard
alduin start               # boot full runtime (Telegram + gateway)
alduin restart gateway     # reload config and restart the runtime
alduin reconfigure         # post-setup menu: change one section without re-running init
alduin update              # pull latest from origin/main, rebuild, restart Telegram if enabled
                           # (requires a git checkout; tracks origin/main — not for feature branches)
alduin telegram restart    # restart the Telegram long-poll connection (one-shot test)
alduin config              # view/edit configuration
alduin doctor              # diagnose config issues
alduin models sync         # probe provider /models APIs
alduin models diff         # compare config pins vs. catalog
alduin models upgrade      # propose new pins, run smoke tests
alduin skills list         # list available skills
alduin skills run <id>     # execute a skill
alduin dev                 # start in development mode (CLI REPL only)
alduin dev:telegram        # start with Telegram adapter (dev shortcut)
alduin test                # run test suite
alduin test:coverage       # run tests with coverage
alduin lint                # type-check the project
alduin clean               # remove compiled output
alduin config:generate     # regenerate config schema
alduin config:check        # verify schema is up to date

npm run build                # compile TypeScript to dist/ (run after pulling new code)
```

## Environment variable overrides

Any config field can be overridden via environment variables without editing `config.yaml`. Use double-underscore (`__`) as the path separator:

```bash
ALDUIN_ORCHESTRATOR__MODEL=anthropic/claude-opus-4-6
ALDUIN_BUDGETS__DAILY_LIMIT_USD=5.0
ALDUIN_MEMORY__HOT_TURNS=10
```

Paths are validated against the schema at startup — unknown paths are rejected, and values are coerced to the correct type automatically.

## Manual configuration (power users)

If you prefer to configure Alduin by hand instead of using the wizard:

1. Copy `.env.example` to `.env` and fill in your API keys
2. Copy `config.example.yaml` to `config.yaml` and edit to taste
3. Run `alduin doctor` to verify your setup

See `config.example.yaml` for all available options and their documentation.

## Securing your Telegram bot

The wizard (Step 5) guides you through Telegram security interactively. If you configured manually, here's what to set up:

### 1. Set an allowed user list in config

Add an `allowed_user_ids` list to your `config.yaml`. Only these Telegram user IDs will be processed — all other messages are silently dropped before reaching the orchestrator, session resolver, or any LLM call.

```yaml
channels:
  telegram:
    enabled: true
    mode: longpoll
    token_env: TELEGRAM_BOT_TOKEN
    allowed_user_ids:
      - 123456789       # your Telegram user ID
      - 987654321       # another authorized user
```

To find your Telegram user ID, message [@userinfobot](https://t.me/userinfobot) on Telegram.

### 2. Configure BotFather privacy settings

These settings are managed through [@BotFather](https://t.me/BotFather) on Telegram:

- **Group Privacy** (`/setprivacy` → Enabled): when the bot is in a group, it only sees messages that start with `/` or directly @mention it. This reduces noise but is not access control — any group member can still invoke it.
- **Join Groups** (`/setjoingroups` → Disabled): prevents anyone from adding your bot to groups. Recommended unless you specifically need group functionality.

Alduin uses long-poll only — no public URL or firewall configuration required.

### Risk summary

| Risk | Without mitigation | With mitigation |
|------|-------------------|-----------------|
| Unauthorized users send messages | Messages hit orchestrator, consume API budget, receive responses | Dropped at adapter level, zero cost |
| Bot added to unknown group | All group members can interact | `/setjoingroups` disabled prevents this |
| Bot token leaked | Full impersonation of your bot | Rotate token via BotFather immediately; revoke old token |

If your bot token is ever compromised, revoke it immediately via BotFather (`/revoke`) and run `alduin init` to re-provision.

## Next steps

- Read [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design
- Explore `config.example.yaml` for all configuration options
- Run `alduin test` to verify the test suite passes on your machine
- Try `/alduin status` in your Telegram chat to see the bot in action
