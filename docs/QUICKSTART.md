# Quickstart

Get Alduin running in under 5 minutes.

## Prerequisites

- **Node.js 22+** — check with `node -v`
- **npm 10+** — ships with Node 22
- At least one provider API key (Anthropic, OpenAI, or DeepSeek)
- Optional: [Ollama](https://ollama.com) for local models

## 1. Clone and install

```bash
git clone https://github.com/BasementAnon/alduin.git
cd alduin
npm install
npm run build
```

## 2. Set up your environment

Copy the example env file and fill in your API keys:

```bash
cp .env.example .env
```

Open `.env` and add at minimum one provider key:

```bash
ANTHROPIC_API_KEY=sk-ant-...
# or
OPENAI_API_KEY=sk-...
```

If you plan to use the Telegram bot, also set:

```bash
TELEGRAM_BOT_TOKEN=123456789:ABCdef...
```

## 3. Run the setup wizard

```bash
npm run init
```

The wizard walks you through:

1. **Channel** — Telegram or CLI-only; long-poll (dev) or webhook (prod)
2. **Tokens** — bot token is written directly to the encrypted vault (never stored as plaintext on disk)
3. **Models** — pick your orchestrator and classifier from the pinned catalog
4. **Budget** — set a daily spend limit, warning threshold, and optional per-model caps
5. **Self-test** — runs one classifier + one orchestrator round-trip to verify everything works

You can Ctrl-C at any step safely. The wizard generates `config.yaml` — you can also edit this file manually afterward. See `config.example.yaml` for all available options.

## 4. Start Alduin

**Development (CLI-only or Telegram long-poll):**

```bash
npm run dev
```

**Development with Telegram:**

```bash
npm run dev:telegram
```

**Production (webhook mode):**

```bash
npm run build
node dist/cli.js --config config.yaml
```

In production, set `channels.telegram.mode: webhook` in your config and provide a public HTTPS URL.

## 5. Verify your setup

Run the built-in diagnostics:

```bash
npm run dev -- doctor
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

If you've installed globally (`npm install -g`), use `alduin <command>` directly. From a local clone, use `npm run dev --` as the prefix:

```bash
# From a local clone                    # If installed globally
npm run init                             alduin init
npm run dev -- config                    alduin config
npm run dev -- doctor                    alduin doctor
npm run dev -- models sync               alduin models sync
npm run dev -- models diff               alduin models diff
npm run dev -- models upgrade             alduin models upgrade
npm run dev -- skills list               alduin skills list
npm run dev -- skills run <id>           alduin skills run <id>
```

## Environment variable overrides

Any config field can be overridden via environment variables without editing `config.yaml`. Use double-underscore (`__`) as the path separator:

```bash
ALDUIN_ORCHESTRATOR__MODEL=anthropic/claude-opus-4-6
ALDUIN_BUDGETS__DAILY_LIMIT_USD=5.0
ALDUIN_MEMORY__HOT_TURNS=10
```

Paths are validated against the schema at startup — unknown paths are rejected, and values are coerced to the correct type automatically.

## Securing your Telegram bot

By default, any Telegram user who discovers your bot's username can send it messages. Those messages will hit the orchestrator and consume your API budget. You should lock this down before running in any environment where the bot token could be exposed.

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

### 3. Webhook mode hardening

If running in webhook mode, also ensure:

- Firewall the webhook port to only accept traffic from Telegram's IP ranges (`149.154.160.0/20` and `91.108.4.0/22`).
- Set `TELEGRAM_WEBHOOK_SECRET` in your `.env` and configure it in BotFather — Alduin verifies this signature on every inbound webhook.
- Never expose the webhook endpoint on a wildcard (`0.0.0.0`) without a reverse proxy in front.

### Risk summary

| Risk | Without mitigation | With mitigation |
|------|-------------------|-----------------|
| Unauthorized users send messages | Messages hit orchestrator, consume API budget, receive responses | Dropped at adapter level, zero cost |
| Bot added to unknown group | All group members can interact | `/setjoingroups` disabled prevents this |
| Webhook endpoint discovered | Attacker can forge inbound messages | Signature verification + IP allowlist reject forgeries |
| Bot token leaked | Full impersonation of your bot | Rotate token via BotFather immediately; revoke old token |

If your bot token is ever compromised, revoke it immediately via BotFather (`/revoke`) and run `npm run init` to re-provision.

## Next steps

- Read [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design
- Explore `config.example.yaml` for all configuration options
- Run `npm test` to verify the test suite passes on your machine
- Try `/alduin status` in your Telegram chat to see the bot in action
