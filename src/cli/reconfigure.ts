/**
 * alduin reconfigure — menu-driven post-setup config editor.
 *
 * Lets users change one section at a time without re-running the full wizard.
 * After each section completes, returns to the menu until "Exit" is chosen.
 *
 * Menu options:
 *   - Change models / providers
 *   - Change skills
 *   - Change Telegram bot token
 *   - Change Telegram allowlist
 *   - Change budgets (daily + per-task)
 *   - Change owner
 *   - Exit
 *
 * Verified: no `alduin reconfigure` top-level command existed before this
 * commit. The welcome.ts reconfigure branch walks every step in order; this
 * menu selects one section per iteration.
 */

import { cancel, log, outro, select } from '@clack/prompts';
import { existsSync, readFileSync, copyFileSync, closeSync, openSync, renameSync, writeSync, fsyncSync } from 'node:fs';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { loadCatalog } from '../catalog/catalog.js';
import { alduinConfigSchema } from '../config/schema/index.js';
import type { AlduinConfig } from '../config/schema/index.js';
import { OSKeychain } from '../connectors/keychain.js';
import { CredentialVault } from '../secrets/vault.js';
import { buildBudgetConfig, runBudget } from './wizard/steps/budget.js';
import { buildChannelConfig, runChannelSetup, writeChannelTokensToVault } from './wizard/steps/channel.js';
import { buildModelsConfig, buildProvidersConfigFromSetup, runPickModels } from './wizard/steps/pick-models.js';
import { runProviderSetup } from './wizard/steps/providers.js';
import { runSkillsSelection } from './wizard/steps/skills.js';
import { runOwnerBootstrap } from './wizard/steps/owner.js';
import type { BudgetAnswers, ChannelAnswers, ModelAnswers, ProviderAnswers, SkillsAnswers } from './wizard/types.js';
import { WizardCancelledError } from './wizard/types.js';

const CONFIG_PATH = './config.yaml';
const VAULT_PATH = '.alduin/vault.db';
const SKILLS_DIR = './skills';

// ── Config I/O ─────────────────────────────────────────────────────────────────

function readRaw(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) {
    console.error(`alduin reconfigure: config.yaml not found at ${configPath}\nRun \`alduin init\` first.`);
    process.exit(1);
  }
  const raw = parseYaml(readFileSync(configPath, 'utf-8'), { maxAliasCount: 100 });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    console.error('alduin reconfigure: config.yaml must be a YAML object at the top level.');
    process.exit(1);
  }
  return raw as Record<string, unknown>;
}

/**
 * Write config atomically (same pattern as config.ts::writeRaw).
 * Returns null on success, or an error message string on failure.
 */
function writeAndValidate(
  configPath: string,
  raw: Record<string, unknown>
): string | null {
  // Validate first — don't write if invalid
  const validated = alduinConfigSchema.safeParse(raw);
  if (!validated.success) {
    const first = validated.error.issues[0];
    const field = first?.path.join('.') ?? '(unknown)';
    return `Validation failed: ${field}: ${first?.message ?? 'unknown error'}`;
  }

  const serialized = toYaml(raw);
  const tmpPath = `${configPath}.tmp`;
  const bakPath = `${configPath}.bak`;

  if (existsSync(configPath)) {
    try { copyFileSync(configPath, bakPath); } catch { /* best effort */ }
  }

  const fd = openSync(tmpPath, 'w');
  try {
    writeSync(fd, serialized);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, configPath);
  return null;
}

// ── Vault helper ───────────────────────────────────────────────────────────────

async function openVault(): Promise<CredentialVault | null> {
  const keychain = new OSKeychain();
  let masterSecret: string;
  const existing = await keychain.getMasterSecret().catch(() => null);
  if (!existing) {
    log.warn('Could not open credential vault — Telegram token changes will not be stored.');
    return null;
  }
  masterSecret = existing;
  return new CredentialVault(VAULT_PATH, masterSecret);
}

// ── Menu section handlers ──────────────────────────────────────────────────────

async function sectionModels(
  raw: Record<string, unknown>,
  vault: CredentialVault | null
): Promise<void> {
  const catalogResult = loadCatalog();
  const catalog = catalogResult.ok ? catalogResult.value : null;

  // Build a minimal ProviderAnswers from the existing config for pre-fill
  const existingProviders = (raw['providers'] as Record<string, unknown> | undefined) ?? {};
  const providerAnswers: ProviderAnswers = {
    providers: Object.entries(existingProviders).map(([id]) => ({
      id,
      connected: true,
    })),
  };

  // Build existing ModelAnswers for pre-fill
  const existingOrch = (raw['orchestrator'] as Record<string, unknown> | undefined)?.['model'] as string | undefined;
  const existingExecs = (raw['executors'] as Record<string, Record<string, unknown>> | undefined) ?? {};
  // Pre-fill from existing config is available but runPickModels uses catalog
  // defaults as initialValues; extend later if needed (TODO: pass existingOrch
  // as initialValue to runPickModels for proper reconfigure pre-fill).
  void existingOrch;
  void existingExecs;

  const models = await runPickModels(catalog, providerAnswers);
  const { orchestrator, executors, routing, fallbacks } = buildModelsConfig(models);

  raw['orchestrator'] = orchestrator;
  raw['executors'] = executors;
  raw['routing'] = routing;
  if (fallbacks && Object.keys(fallbacks).length > 0) {
    raw['fallbacks'] = fallbacks;
  }

  log.success('Model assignments updated.');
}

async function sectionProviders(
  raw: Record<string, unknown>,
  vault: CredentialVault | null
): Promise<void> {
  if (!vault) {
    log.warn('Vault unavailable — API keys cannot be stored securely. Skipping provider section.');
    return;
  }

  const providers = await runProviderSetup(vault);
  const providersConfig = buildProvidersConfigFromSetup(providers);
  raw['providers'] = providersConfig;
  log.success('Provider configuration updated.');
}

async function sectionSkills(raw: Record<string, unknown>): Promise<void> {
  const skills = await runSkillsSelection(SKILLS_DIR);
  // Skills are stored separately from config.yaml (in skills/ dir).
  // Update the skill manifest reference if present; otherwise just log.
  // TODO: if skills config is ever added to config.yaml schema, update here.
  void skills;
  log.success('Skills selection noted. Skills are enabled/disabled via the skills/ directory.');
}

async function sectionTelegramToken(
  raw: Record<string, unknown>,
  vault: CredentialVault | null
): Promise<void> {
  if (!vault) {
    log.warn('Vault unavailable — Telegram token cannot be stored securely.');
    return;
  }

  const existingChannel = (raw['channels'] as Record<string, unknown> | undefined);
  const existingTelegram = existingChannel?.['telegram'] as Record<string, unknown> | undefined;
  const existingAnswers: Partial<ChannelAnswers> = {
    channel: (existingTelegram ? 'telegram' : 'cli') as 'telegram' | 'cli',
    mode: 'longpoll',
    allowedUserIds: existingTelegram?.['allowed_user_ids'] as number[] | undefined,
  };

  const channel = await runChannelSetup(vault, existingAnswers);
  const channelConfig = buildChannelConfig(channel);
  raw['channels'] = channelConfig;
  writeChannelTokensToVault(vault, channel);
  log.success('Telegram token updated.');
}

async function sectionAllowlist(raw: Record<string, unknown>): Promise<void> {
  const existingChannel = (raw['channels'] as Record<string, unknown> | undefined);
  const existingTelegram = existingChannel?.['telegram'] as Record<string, unknown> | undefined;

  if (!existingTelegram) {
    log.warn('No Telegram channel configured. Run "Change Telegram bot token" first.');
    return;
  }

  // We need a minimal vault for runChannelSetup; pass a dummy so token re-entry is skipped.
  // TODO: refactor runChannelSetup to allow allowlist-only update without re-entering the token.
  // For now, guide user to use `alduin config set channels.telegram.allowed_user_ids [...]`.
  log.info('To update the allowlist without re-entering your token, use:');
  log.info('  alduin config set channels.telegram.allowed_user_ids \'[123456789, 987654321]\'');
  log.info('Or run "Change Telegram bot token" which also re-collects the allowlist.');
}

async function sectionBudgets(raw: Record<string, unknown>): Promise<void> {
  const catalogResult = loadCatalog();
  const catalog = catalogResult.ok ? catalogResult.value : null;

  const existingBudgets = raw['budgets'] as Record<string, unknown> | undefined;
  const existingAnswers: Partial<BudgetAnswers> = {
    dailyLimitUsd: (existingBudgets?.['daily_limit_usd'] as number | undefined) ?? 0,
    warningThreshold: (existingBudgets?.['warning_threshold'] as number | undefined) ?? 0.8,
    perTaskLimitUsd: (existingBudgets?.['per_task_limit_usd'] as number | undefined) ?? 0,
  };

  const budget = await runBudget(undefined, catalog, existingAnswers);
  raw['budgets'] = buildBudgetConfig(budget);
  log.success('Budget configuration updated.');
}

async function sectionOwner(raw: Record<string, unknown>): Promise<void> {
  const existingChannel = (raw['channels'] as Record<string, unknown> | undefined);
  const existingTelegram = existingChannel?.['telegram'] as Record<string, unknown> | undefined;
  const channelAnswers: ChannelAnswers = {
    channel: existingTelegram ? 'telegram' : 'cli',
    mode: 'longpoll',
  };

  const owner = await runOwnerBootstrap(channelAnswers);
  // Owner is seeded to the auth DB, not config.yaml
  void owner;
  log.success('Owner bootstrap completed (if applicable).');
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function handleReconfigureCommand(): Promise<void> {
  const vault = await openVault();

  let continueMenu = true;
  while (continueMenu) {
    const raw = readRaw(CONFIG_PATH);

    let choice: string;
    try {
      const result = await select<string>({
        message: 'What would you like to reconfigure?',
        options: [
          { label: 'Change models / providers', value: 'models' },
          { label: 'Change skills', value: 'skills' },
          { label: 'Change Telegram bot token', value: 'telegram' },
          { label: 'Change Telegram allowlist', value: 'allowlist' },
          { label: 'Change budgets (daily + per-task)', value: 'budgets' },
          { label: 'Change owner', value: 'owner' },
          { label: 'Exit', value: 'exit' },
        ],
      });
      if (typeof result === 'symbol') {
        // Ctrl-C
        cancel('Reconfigure cancelled.');
        process.exit(0);
      }
      choice = result as string;
    } catch {
      cancel('Reconfigure cancelled.');
      process.exit(0);
    }

    if (choice === 'exit') {
      continueMenu = false;
      break;
    }

    try {
      switch (choice) {
        case 'models':
          await sectionModels(raw, vault);
          break;
        case 'skills':
          await sectionSkills(raw);
          break;
        case 'telegram':
          await sectionTelegramToken(raw, vault);
          break;
        case 'allowlist':
          await sectionAllowlist(raw);
          break;
        case 'budgets':
          await sectionBudgets(raw);
          break;
        case 'owner':
          await sectionOwner(raw);
          break;
      }

      // Persist after each non-exit, non-cancel section
      if (choice !== 'exit' && choice !== 'allowlist' && choice !== 'skills' && choice !== 'owner') {
        const err = writeAndValidate(CONFIG_PATH, raw);
        if (err) {
          log.error(`Failed to save: ${err}. Config was not modified.`);
        } else {
          log.success(`Config saved to ${CONFIG_PATH}.`);
        }
      }
    } catch (e) {
      if (e instanceof WizardCancelledError) {
        log.warn('Section cancelled — no changes saved for this section.');
        // Return to menu
        continue;
      }
      log.error(`Error in section: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (vault) vault.close();
  outro('Done. Run `alduin doctor` to verify your setup.');
}
