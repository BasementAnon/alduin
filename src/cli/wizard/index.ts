// ─────────────────────────────────────────────────────────────
// Adapted from OpenClaw (MIT, © Peter Steinberger)
//   Origin: src/wizard/setup.ts (flow structure, @clack/prompts pattern)
//   Origin SHA: 778ac4330aa32b9ce4482f0d1a3d4f744ff7f17f
//   Ported: 2026-04-15
// ─────────────────────────────────────────────────────────────

/**
 * Alduin first-run wizard.
 *
 * Flow (each step is interruptible via Ctrl-C):
 *   1. pick-channel  — Telegram vs CLI, longpoll vs webhook
 *   2. paste-tokens  — bot token into vault; auto-generate webhook secret
 *   3. pick-models   — orchestrator + classifier from catalog; pin validation
 *   4. budget        — daily limit, warning threshold, optional per-model caps
 *   5. self-test     — classifier + orchestrator round-trip; latency + cost
 *
 * On Ctrl-C before commit: if enough data was collected the user is offered a
 * chance to save a partial config so they can resume later.
 */

import { cancel, confirm, intro, log, note, outro } from '@clack/prompts';
import { existsSync, writeFileSync } from 'node:fs';
import { stringify as toYaml } from 'yaml';
import { loadCatalog } from '../../catalog/catalog.js';
import type { AlduinConfig } from '../../config/types.js';
import { OSKeychain } from '../../connectors/keychain.js';
import { CredentialVault } from '../../secrets/vault.js';
import {
  appendWizardAuditEntry,
  ensureDir,
  guard,
  writeEnvVar,
} from './helpers.js';
import { buildChannelConfig, runPickChannel } from './steps/pick-channel.js';
import { runPasteTokens, writeTokensToVault } from './steps/paste-tokens.js';
import { buildBudgetConfig, runBudget } from './steps/budget.js';
import { buildModelsConfig, runPickModels } from './steps/pick-models.js';
import { formatSelfTestReport, runSelfTest } from './steps/self-test.js';
import type { ChannelAnswers, BudgetAnswers, ModelAnswers, TokenAnswers, WizardCancelledError, WizardState } from './types.js';

const CONFIG_PATH = './config.yaml';
const VAULT_PATH = '.alduin/vault.db';
const CATALOG_VERSION = '2026-04-14';

// ── Config assembly ───────────────────────────────────────────────────────────

function assembleConfig(state: WizardState): AlduinConfig {
  const { channel, tokens, models, budget } = state;
  const { orchestrator, executors, providers, routing, fallbacks } =
    buildModelsConfig(models);

  const config: AlduinConfig = {
    catalog_version: CATALOG_VERSION,
    orchestrator,
    executors,
    providers,
    routing,
    budgets: buildBudgetConfig(budget),
    channels: buildChannelConfig(channel),
    tenants: { default_tenant_id: 'default' },
    memory: {
      hot_turns: 3,
      warm_max_tokens: 500,
      cold_enabled: true,
      cold_similarity_threshold: 0.7,
    },
    ingestion: {
      max_bytes: 25 * 1024 * 1024,
      ocr_enabled: false,
      stt_enabled: false,
    },
  };

  if (Object.keys(fallbacks).length > 0) {
    config.fallbacks = fallbacks;
  }

  void tokens; // tokens are written to vault separately, not embedded in config
  return config;
}

/** True when enough state has been collected to write a minimal valid config. */
function isCommittable(state: Partial<WizardState>): state is WizardState {
  return !!(state.channel && state.tokens && state.models && state.budget);
}

// ── Vault setup ───────────────────────────────────────────────────────────────

async function openVault(): Promise<{ vault: CredentialVault; masterSecret: string } | null> {
  const keychain = new OSKeychain();

  let masterSecret: string;
  const existing = await keychain.getMasterSecret().catch(() => null);
  if (existing) {
    masterSecret = existing;
  } else {
    try {
      masterSecret = await keychain.generateAndStore();
      log.success('Generated vault master secret in OS keychain.');
    } catch (err) {
      log.error(
        `Cannot create credential vault:\n  ${err instanceof Error ? err.message : String(err)}\n\n` +
          'Run `npm i keytar` (OS keychain) or set ALDUIN_VAULT_SECRET in .env, then re-run.'
      );
      return null;
    }
  }

  const existingAuditKey = await keychain.getAuditHmacKey().catch(() => null);
  if (!existingAuditKey) {
    try {
      await keychain.generateAndStoreAuditKey();
      log.success('Generated audit HMAC key in OS keychain.');
    } catch (err) {
      log.warn(
        `Cannot persist audit key: ${err instanceof Error ? err.message : String(err)}\n` +
          'Set ALDUIN_AUDIT_HMAC_KEY in .env to a 64-char hex string.'
      );
    }
  }

  ensureDir('.alduin');
  const vault = new CredentialVault(VAULT_PATH, masterSecret);
  return { vault, masterSecret };
}

// ── Commit ────────────────────────────────────────────────────────────────────

async function commit(
  state: WizardState,
  vault: CredentialVault
): Promise<void> {
  // 1. Assemble + write config.yaml
  const config = assembleConfig(state);
  writeFileSync(CONFIG_PATH, toYaml(config), 'utf-8');
  log.success(`Config written to ${CONFIG_PATH}`);

  // 2. Seed vault with credentials
  writeTokensToVault(vault, state.channel, state.tokens);
  log.success('Credentials stored in encrypted vault.');

  // 3. Write env var stubs to .env so the runtime can reference them
  if (state.channel.channel === 'telegram' && !existsSync('.env')) {
    writeEnvVar('TELEGRAM_BOT_TOKEN', state.tokens.botToken ?? '');
  }
}

// ── Main wizard ───────────────────────────────────────────────────────────────

/**
 * Run the full init wizard. Replaces the legacy `src/cli/init.ts`.
 * Called by `alduin init`.
 */
export async function runInitWizard(): Promise<void> {
  intro('Alduin — First-Run Setup');

  // Guard against re-init
  if (existsSync(CONFIG_PATH)) {
    const overwrite = guard(
      await confirm({
        message: `${CONFIG_PATH} already exists. Overwrite?`,
        initialValue: false,
      })
    );
    if (!overwrite) {
      outro('Existing config preserved. Run `alduin init` again to reconfigure.');
      return;
    }
  }

  // Load catalog for model selection
  const catalogResult = loadCatalog();
  const catalog = catalogResult.ok ? catalogResult.value : null;
  if (!catalog) {
    log.warn('Model catalog could not be loaded — model selection will use built-in defaults.');
  }

  // Open / create vault (abort if keychain is unavailable)
  const vaultResult = await openVault();
  if (!vaultResult) {
    cancel('Vault setup failed. See instructions above.');
    process.exit(1);
  }
  const { vault } = vaultResult;

  // ── Collect answers (interruptible) ─────────────────────────────────────────
  const state: Partial<WizardState> = {};

  try {
    state.channel = await runPickChannel();
    state.tokens = await runPasteTokens(state.channel);
    state.models = await runPickModels(catalog);
    state.budget = await runBudget();
  } catch (e) {
    // WizardCancelledError — user pressed Ctrl-C
    const name = (e as WizardCancelledError).name;
    if (name === 'WizardCancelledError') {
      if (isCommittable(state)) {
        const save = await confirm({
          message: 'Save partial config before exiting?',
          initialValue: false,
        }).catch(() => false);

        if (save && !isSymbol(save)) {
          await commit(state, vault);
          note(
            'Partial config saved. Run `alduin init` to complete or resume setup.',
            'Partial save'
          );
          appendWizardAuditEntry('wizard partial-save (cancelled during budget step)');
        }
      }
      cancel('Setup cancelled.');
      vault.close();
      process.exit(0);
    }
    vault.close();
    throw e;
  }

  // ── Commit (all steps completed) ─────────────────────────────────────────────
  try {
    await commit(state as WizardState, vault);
  } catch (e) {
    log.error(`Failed to write config: ${e instanceof Error ? e.message : String(e)}`);
    vault.close();
    process.exit(1);
  }

  // ── Step 5: self-test (optional) ─────────────────────────────────────────────
  let selfTestSummary = 'skipped';
  try {
    const report = await runSelfTest(
      vault,
      state.models,
      state.channel.channel,
      catalog
    );
    if (report) {
      const formatted = formatSelfTestReport(report);
      note(formatted, 'Self-test results');
      const allOk = Object.values(report).every((r) => r?.ok !== false);
      selfTestSummary = allOk ? 'passed' : 'partial-failure';
    }
  } catch {
    log.warn('Self-test did not complete — run `alduin doctor` to verify your setup.');
    selfTestSummary = 'error';
  }

  // ── Audit entry ───────────────────────────────────────────────────────────────
  appendWizardAuditEntry(
    `wizard completed: channel=${state.channel.channel} mode=${state.channel.mode} ` +
      `orchestrator=${state.models.orchestratorModel} classifier=${state.models.classifierModel} ` +
      `budget=$${state.budget.dailyLimitUsd}/day self-test=${selfTestSummary}`
  );

  vault.close();

  // ── Outro ─────────────────────────────────────────────────────────────────────
  const mode = state.channel.mode;
  outro(`\
Alduin is configured!

Next steps:
  1. npm run build
  2. ${mode === 'longpoll' ? 'npx alduin' : 'npx alduin --config config.yaml'}

Run 'alduin models diff' to check catalog alignment.
Run 'alduin doctor' to verify your complete setup.`);
}

function isSymbol(v: unknown): v is symbol {
  return typeof v === 'symbol';
}
