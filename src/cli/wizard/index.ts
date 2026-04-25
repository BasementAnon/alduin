// ─────────────────────────────────────────────────────────────
// Adapted from OpenClaw (MIT, © Peter Steinberger)
//   Origin: src/wizard/setup.ts (flow structure, @clack/prompts pattern)
//   Origin SHA: 778ac4330aa32b9ce4482f0d1a3d4f744ff7f17f
//   Ported: 2026-04-15
// ─────────────────────────────────────────────────────────────

/**
 * Alduin first-run wizard.
 *
 * Flow (10 steps, each Ctrl-C safe):
 *   0. prerequisites    — Node ≥ 22, node_modules, build freshness
 *   1. welcome          — version, fresh vs reconfigure
 *   2. provider-setup   — multi-select providers, API keys, connectivity test
 *   3. pick-models      — per-role model assignment from catalog
 *   4. budget           — daily, per-task, per-model limits
 *   5. channel          — CLI / Telegram / Both + token validation + security
 *   6. skills           — multi-select curated skills
 *   7. owner-bootstrap  — seed first owner role
 *   8. self-test        — round-trip LLM + Telegram connectivity
 *   9. summary          — review, confirm, atomic write
 *
 * All config choices are held in memory until Step 9. Vault writes happen
 * inline (Steps 2 and 5) but are cleaned up on Ctrl-C via an exit handler.
 */

import { cancel, log, note } from '@clack/prompts';
import { stringify as toYaml } from 'yaml';
import { loadCatalog } from '../../catalog/catalog.js';
import type { AlduinConfig } from '../../config/types.js';
import { OSKeychain } from '../../connectors/keychain.js';
import { CredentialVault } from '../../secrets/vault.js';
import { bootstrapOwner, formatBootstrapError } from '../../auth/bootstrap.js';
import { openSqlite } from '../../db/open.js';
import {
  appendWizardAuditEntry,
  ensureDir,
  writeEnvVar,
} from './helpers.js';
import type { WizardState } from './types.js';
import { WizardCancelledError } from './types.js';

// Steps
import { runPrerequisites } from './steps/prerequisites.js';
import { runWelcome } from './steps/welcome.js';
import { runProviderSetup, cleanupVaultScopes } from './steps/providers.js';
import { buildModelsConfig, buildProvidersConfigFromSetup, runPickModels } from './steps/pick-models.js';
import { buildBudgetConfig, runBudget } from './steps/budget.js';
import { buildChannelConfig, runChannelSetup, writeChannelTokensToVault } from './steps/channel.js';
import { runSkillsSelection } from './steps/skills.js';
import { runOwnerBootstrap } from './steps/owner.js';
import { formatSelfTestReport, runSelfTest } from './steps/self-test.js';
import { commitConfig, runSummary } from './steps/summary.js';

const CONFIG_PATH = './config.yaml';
const VAULT_PATH = '.alduin/vault.db';
const AUTH_DB_PATH = '.alduin-sessions.db';
const SKILLS_DIR = './skills';
const CATALOG_VERSION = '2026-04-14';

// ── Config assembly ───────────────────────────────────────────────────────────

function assembleConfig(state: WizardState): AlduinConfig {
  const { orchestrator, executors, routing, fallbacks } = buildModelsConfig(state.models);
  const providers = buildProvidersConfigFromSetup(state.providerSetup);

  const config: AlduinConfig = {
    catalog_version: CATALOG_VERSION,
    orchestrator,
    executors,
    providers,
    routing,
    budgets: buildBudgetConfig(state.budget),
    channels: buildChannelConfig(state.channel),
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

  if (fallbacks && Object.keys(fallbacks).length > 0) {
    config.fallbacks = fallbacks;
  }

  return config;
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
      // If ALDUIN_VAULT_SECRET was just written to .env (keytar fallback),
      // report accordingly; otherwise it went to the OS keychain.
      if (process.env['ALDUIN_VAULT_SECRET'] === masterSecret) {
        log.success('Generated vault master secret (saved to .env).');
      } else {
        log.success('Generated vault master secret in OS keychain.');
      }
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
      const newAuditKey = await keychain.generateAndStoreAuditKey();
      if (process.env['ALDUIN_AUDIT_HMAC_KEY'] === newAuditKey) {
        log.success('Generated audit HMAC key (saved to .env).');
      } else {
        log.success('Generated audit HMAC key in OS keychain.');
      }
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

// ── Owner commit ──────────────────────────────────────────────────────────────

function commitOwner(state: WizardState, config: AlduinConfig): void {
  if (!state.owner?.userId) return;

  const authDb = openSqlite(AUTH_DB_PATH);
  try {
    const tenantId =
      state.owner.tenantId || config.tenants?.default_tenant_id || 'default';
    const result = bootstrapOwner(authDb, {
      tenantId,
      userId: state.owner.userId,
    });
    if (result.ok) {
      log.success(
        `Owner seeded: tenant="${result.value.tenantId}" user_id="${result.value.userId}".`
      );
    } else if (result.error.kind === 'owner_exists') {
      log.warn(
        `Owner already exists for tenant "${result.error.tenantId}" ` +
          `(user_id="${result.error.existingUserId}"). Skipping — use admin role ` +
          'commands to transfer ownership.'
      );
    } else {
      log.warn(formatBootstrapError(result.error));
    }
  } finally {
    authDb.close();
  }
}

// ── Ctrl-C exit handler ───────────────────────────────────────────────────────

function installExitHandler(vault: CredentialVault): () => void {
  const handler = (): void => {
    try {
      cleanupVaultScopes(vault);
    } catch {
      // best effort
    }
    try {
      vault.close();
    } catch {
      // best effort
    }
  };

  const sigintHandler = (): void => {
    handler();
    process.exit(130);
  };
  const sigtermHandler = (): void => {
    handler();
    process.exit(143);
  };

  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);

  return handler;
}

// ── Main wizard ───────────────────────────────────────────────────────────────

export async function runInitWizard(): Promise<void> {
  // ── Step 0: Prerequisites ───────────────────────────────────────────────────
  const prereqOk = runPrerequisites();
  if (!prereqOk) {
    process.exit(1);
  }

  // ── Step 1: Welcome ─────────────────────────────────────────────────────────
  const welcome = await runWelcome(CONFIG_PATH);

  // Load catalog for model selection
  const catalogResult = loadCatalog();
  const catalog = catalogResult.ok ? catalogResult.value : null;
  if (!catalog) {
    log.warn('Model catalog could not be loaded — model selection will use built-in defaults.');
  }

  // Open / create vault
  const vaultResult = await openVault();
  if (!vaultResult) {
    cancel('Vault setup failed. See instructions above.');
    process.exit(1);
  }
  const { vault } = vaultResult;
  installExitHandler(vault);

  // ── Collect answers (interruptible) ─────────────────────────────────────────
  const state: Partial<WizardState> = { welcome };

  try {
    // Step 2: Provider setup
    state.providerSetup = await runProviderSetup(vault);

    // Step 3: Model assignment
    state.models = await runPickModels(catalog, state.providerSetup);

    // Step 4: Budget
    state.budget = await runBudget(state.models, catalog);

    // Step 5: Channel setup
    state.channel = await runChannelSetup(vault);

    // Step 6: Skills selection
    state.skills = await runSkillsSelection(SKILLS_DIR);

    // Step 7: Owner bootstrap
    state.owner = await runOwnerBootstrap(state.channel);

    // Step 8: Self-test
    const testReport = await runSelfTest(
      state.models,
      state.channel,
      state.providerSetup,
      catalog
    );
    if (testReport) {
      const formatted = formatSelfTestReport(testReport);
      note(formatted, 'Self-test results');
    }
  } catch (e) {
    if (e instanceof WizardCancelledError) {
      appendWizardAuditEntry('wizard cancelled by user');
      cancel('Setup cancelled.');
      vault.close();
      process.exit(0);
    }
    vault.close();
    throw e;
  }

  // Type-check: ensure all required state is present
  if (
    !state.welcome ||
    !state.providerSetup ||
    !state.models ||
    !state.budget ||
    !state.channel ||
    !state.skills
  ) {
    cancel('Incomplete wizard state — this is a bug.');
    vault.close();
    process.exit(1);
  }

  const fullState = state as WizardState;

  // ── Step 9: Summary + write ─────────────────────────────────────────────────
  try {
    const confirmed = await runSummary(fullState, catalog, CONFIG_PATH);
    if (!confirmed) {
      vault.close();
      process.exit(0);
    }

    // Assemble and write config
    const config = assembleConfig(fullState);
    const configYaml = toYaml(config, { lineWidth: 120 });

    // Commit config atomically
    commitConfig(configYaml, CONFIG_PATH, fullState.channel);

    // Write channel tokens to vault (idempotent — may already be written in Step 5)
    writeChannelTokensToVault(vault, fullState.channel);

    // Seed owner role
    commitOwner(fullState, config);

    // Write all secrets to .env in one pass (deferred from steps 2 and 5)
    for (const p of fullState.providerSetup.providers) {
      if (p.apiKey) {
        const envKey = p.id === 'anthropic' ? 'ANTHROPIC_API_KEY'
          : p.id === 'openai' ? 'OPENAI_API_KEY'
          : p.id === 'deepseek' ? 'DEEPSEEK_API_KEY'
          : p.id === 'openai-compatible' ? 'CUSTOM_LLM_API_KEY'
          : `${p.id.toUpperCase()}_API_KEY`;
        writeEnvVar(envKey, p.apiKey);
      }
    }
    if (fullState.channel.botToken) {
      writeEnvVar('TELEGRAM_BOT_TOKEN', fullState.channel.botToken);
    }
    // ALDUIN_WEBHOOK_SECRET is no longer written — webhook mode removed from
    // user journey (plan item #5). The runtime webhook code is still compiled
    // but not wired through wizard.

    // Audit entry
    const a = fullState.models.assignments;
    appendWizardAuditEntry(
      `wizard completed: channel=${fullState.channel.channel} mode=${fullState.channel.mode} ` +
        `orchestrator=${a.orchestrator} classifier=${a.classifier} ` +
        `providers=${fullState.providerSetup.providers.map((p) => p.id).join(',')} ` +
        `budget=$${fullState.budget.dailyLimitUsd}/day ` +
        `skills=${fullState.skills.enabledSkills.join(',') || 'none'}`
    );
  } catch (e) {
    log.error(`Failed to write config: ${e instanceof Error ? e.message : String(e)}`);
    vault.close();
    process.exit(1);
  }

  vault.close();
}
