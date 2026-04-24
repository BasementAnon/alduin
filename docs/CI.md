# CI Guide

This document explains the automated checks that run in CI and how to resolve
each one locally.

---

## Config schema drift check

**Script:** `alduin config:check`
**Exit code:** 0 = up to date, 1 = drift detected

### What it checks

`src/config/schema.generated.ts` is a committed, auto-generated file that
contains the JSON Schema (Draft-07) for `config.yaml`, enriched with UI
metadata from `src/config/schema-hints.ts`.

The drift check re-generates the schema in memory and compares it against the
committed file. If they differ, CI fails with a diff showing exactly which
lines changed.

### When it fails

The check fails whenever any of these files change without a corresponding
regeneration commit:

| Source file | What it affects |
|---|---|
| `src/config/schema/secrets.ts` | SecretRef / SecretInput schema |
| `src/config/schema/models.ts` | Orchestrator and executor schemas |
| `src/config/schema/providers.ts` | Provider config schema |
| `src/config/schema/channels.ts` | Channel (Telegram, …) schemas |
| `src/config/schema/agents.ts` | Routing, budget, memory schemas |
| `src/config/schema/index.ts` | Root AlduinConfig composition |
| `src/config/schema-hints.ts` | UI labels, help text, sensitive flags |

### How to resolve

```bash
alduin config:generate
git add src/config/schema.generated.ts
git commit -m "chore: regenerate config schema"
```

### How it works (technical detail)

`scripts/generate-schema.ts` performs these steps each run:

1. **Zod → JSON Schema** — uses `zod-to-json-schema` to convert
   `alduinConfigSchema` to JSON Schema Draft-07.
2. **Hint enrichment** — walks the JSON Schema tree and injects `title`,
   `description`, `x-alduin-sensitive`, and `x-alduin-advanced` from
   `SCHEMA_HINTS` (keyed by the same dotted paths used by `ALDUIN_*__` env
   overrides).
3. **Plugin merge** — merges any schemas contributed by plugins in
   `plugins/builtin/*/alduin.plugin.json`. Currently empty; reserved for
   Phase 2.
4. **Input SHA** — SHA-256 (first 16 hex chars) of the concatenated source
   file contents. This is embedded in `schema.generated.ts` as `INPUT_SHA`
   and is the primary signal for drift detection.
5. **Drift comparison** — in `--check` mode the script normalises away the
   `Generated at:` timestamp comment (which changes every run) and compares
   the rest character-for-character.

### Adding new config fields

1. Add the field to the appropriate domain schema in `src/config/schema/`.
2. Add a hint entry in `src/config/schema-hints.ts`.
3. Run `alduin config:generate` and commit the updated generated file.

### Marking a field sensitive

Fields matching patterns like `api_key`, `token`, or `secret` are
automatically marked `x-alduin-sensitive: true` in the generated schema by
`isSensitivePath()` in `schema-hints.ts`. To override the auto-detection,
explicitly set `sensitive: true` (or `false`) on the hint entry.

---

## Adding a CI step (GitHub Actions example)

```yaml
# .github/workflows/ci.yml
- name: Check config schema drift
  run: npm run config:check
```

This step should run **after** `npm ci` and **before** any deployment step.
It requires no network access and completes in under a second.
