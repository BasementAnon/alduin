/**
 * Step 9 — Summary + atomic write.
 *
 * Displays a full summary of all choices, estimated monthly cost,
 * and atomically writes config.yaml (tmp → fsync → rename).
 */

import { confirm, log, note, outro } from '@clack/prompts';
import { closeSync, openSync, renameSync, unlinkSync, writeFileSync, fsyncSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify as toYaml } from 'yaml';
import type { ModelCatalog } from '../../../catalog/catalog.js';
import { guard } from '../helpers.js';
import type { WizardState } from '../types.js';

// ── Summary formatter ─────────────────────────────────────────────────────────

export function formatSummary(state: WizardState, catalog: ModelCatalog | null): string {
  const lines: string[] = [];
  const a = state.models.assignments;

  lines.push('┌─ Providers ───────────────────────────────────────');
  for (const p of state.providerSetup.providers) {
    const status = p.connected ? '✓' : '✗';
    const keyInfo = p.apiKey ? '(key set)' : p.baseUrl ? p.baseUrl : '';
    lines.push(`│  ${status} ${p.id.padEnd(20)} ${keyInfo}`);
  }

  lines.push('├─ Models ──────────────────────────────────────────');
  lines.push(`│  Orchestrator:  ${a.orchestrator}`);
  lines.push(`│  Classifier:    ${a.classifier}`);
  lines.push(`│  Code:          ${a.code}`);
  lines.push(`│  Research:      ${a.research}`);
  lines.push(`│  Content:       ${a.content}`);
  lines.push(`│  Quick:         ${a.quick}`);

  lines.push('├─ Budget ──────────────────────────────────────────');
  lines.push(`│  Daily limit:   $${state.budget.dailyLimitUsd.toFixed(2)}`);
  lines.push(`│  Per-task:      $${state.budget.perTaskLimitUsd.toFixed(2)}`);
  lines.push(`│  Warning at:    ${(state.budget.warningThreshold * 100).toFixed(0)}%`);
  if (state.budget.perModelLimits) {
    for (const [model, limit] of Object.entries(state.budget.perModelLimits)) {
      lines.push(`│    ${model}: $${limit.toFixed(2)}/day`);
    }
  }

  lines.push('├─ Channel ─────────────────────────────────────────');
  if (state.channel.channel === 'cli') {
    lines.push('│  CLI only');
  } else {
    lines.push(`│  Channel:       ${state.channel.channel}`);
    lines.push(`│  Mode:          ${state.channel.mode}`);
    if (state.channel.botUsername) {
      lines.push(`│  Bot:           @${state.channel.botUsername}`);
    }
    if (state.channel.webhookUrl) {
      lines.push(`│  Webhook URL:   ${state.channel.webhookUrl}`);
    }
    if (state.channel.allowedUserIds && state.channel.allowedUserIds.length > 0) {
      lines.push(`│  Allowed users: ${state.channel.allowedUserIds.join(', ')}`);
    }
  }

  lines.push('├─ Skills ──────────────────────────────────────────');
  if (state.skills.enabledSkills.length === 0) {
    lines.push('│  (none)');
  } else {
    for (const id of state.skills.enabledSkills) {
      lines.push(`│  ✓ ${id}`);
    }
  }

  if (state.owner?.userId) {
    lines.push('├─ Owner ───────────────────────────────────────────');
    lines.push(`│  User ID:       ${state.owner.userId}`);
    lines.push(`│  Tenant:        ${state.owner.tenantId}`);
  }

  // Monthly cost estimate
  const monthlyEstimate = estimateMonthlyCost(state, catalog);
  if (monthlyEstimate !== null) {
    lines.push('├─ Cost Estimate ───────────────────────────────────');
    lines.push(`│  Max monthly:   ~$${monthlyEstimate.toFixed(2)}`);
    lines.push(`│  (at full daily utilization of $${state.budget.dailyLimitUsd.toFixed(2)}/day × 30)`);
  }

  lines.push('└───────────────────────────────────────────────────');

  return lines.join('\n');
}

function estimateMonthlyCost(state: WizardState, _catalog: ModelCatalog | null): number | null {
  return state.budget.dailyLimitUsd * 30;
}

// ── Atomic file write ─────────────────────────────────────────────────────────

/**
 * Write a file atomically: write to tmp → fsync → rename.
 * This ensures config.yaml is never left in a half-written state.
 */
export function atomicWriteFile(targetPath: string, content: string): void {
  const dir = dirname(targetPath);
  const tmpPath = join(dir, `.${Date.now()}.tmp`);

  try {
    // Write to tmp file
    writeFileSync(tmpPath, content, 'utf-8');

    // fsync to ensure data is on disk
    const fd = openSync(tmpPath, 'r');
    fsyncSync(fd);
    closeSync(fd);

    // Atomic rename
    renameSync(tmpPath, targetPath);
  } catch (e) {
    // Clean up tmp file on failure
    try {
      unlinkSync(tmpPath);
    } catch {
      // best effort
    }
    throw e;
  }
}

// ── UI ────────────────────────────────────────────────────────────────────────

export async function runSummary(
  state: WizardState,
  catalog: ModelCatalog | null,
  configPath: string
): Promise<boolean> {
  const summary = formatSummary(state, catalog);
  note(summary, 'Configuration Summary');

  const action = guard(
    await confirm({
      message: 'Save this configuration?',
      initialValue: true,
    })
  );

  if (!action) {
    log.info('Configuration not saved. Run `npm run init` again to restart.');
    return false;
  }

  return true;
}

/**
 * Write the final config.yaml atomically and print next-steps.
 */
export function commitConfig(
  configYaml: string,
  configPath: string,
  channel: WizardState['channel']
): void {
  atomicWriteFile(configPath, configYaml);
  log.success(`Config written to ${configPath}`);

  const mode = channel.mode;
  const startCmd = mode === 'longpoll' ? 'npm run dev' : 'npm run dev -- --config config.yaml';

  log.info('');
  log.success('Setup complete!');
  log.info('');
  log.info(`Next steps:`);
  log.info(`  1. Start Alduin:  ${startCmd}`);
  log.info(`  2. Verify setup:  npm run dev -- doctor`);
  log.info(`  3. Check models:  npm run dev -- models diff`);

  if (channel.channel !== 'cli') {
    log.info('');
    note(
      'Remember to configure @BotFather security:\n\n' +
        '  1. /setjoingroups → Disable\n' +
        '  2. /setprivacy    → Enable\n\n' +
        'This prevents unauthorized access to your bot.',
      'BotFather Security Reminder'
    );
  }

  outro('Alduin is ready. Happy orchestrating!');
}
