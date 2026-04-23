/**
 * Step 7 — Owner bootstrap.
 *
 * Seeds the first `owner` role for the default tenant. If Telegram was
 * configured and the user entered allowed_user_ids, reuses the first ID
 * as the owner (avoiding a redundant prompt).
 *
 * CLI-only setups skip this step entirely.
 */

import { confirm, log, text } from '@clack/prompts';
import { guard } from '../helpers.js';
import type { ChannelAnswers, OwnerAnswers } from '../types.js';

// ── Validation ────────────────────────────────────────────────────────────────

export function validateOwnerUserId(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'User ID is required.';
  if (trimmed.length > 128) return 'User ID is too long (≤ 128 chars).';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return 'User ID must not contain control characters.';
  return undefined;
}

// ── UI ────────────────────────────────────────────────────────────────────────

export async function runOwnerBootstrap(
  channel: ChannelAnswers,
  defaultTenantId = 'default'
): Promise<OwnerAnswers | undefined> {
  if (channel.channel === 'cli') {
    log.info('CLI-only mode: owner role is not tied to a channel user — skipping.');
    return undefined;
  }

  // If the user already entered allowed_user_ids, offer to use the first one
  if (channel.allowedUserIds && channel.allowedUserIds.length > 0) {
    const firstId = channel.allowedUserIds[0]!.toString();
    const useExisting = guard(
      await confirm({
        message:
          `Your Telegram user ID ${firstId} (from the allowlist) will be set as the bot owner.\n` +
          '  The owner can run /alduin admin commands. Continue?',
        initialValue: true,
      })
    );

    if (useExisting) {
      log.success(`Owner will be seeded: user_id="${firstId}" tenant="${defaultTenantId}"`);
      return { tenantId: defaultTenantId, userId: firstId };
    }
  }

  // Otherwise prompt for the owner user ID
  const wantsBootstrap = guard(
    await confirm({
      message:
        'Seed the first owner for this tenant now?\n' +
        '  Owners can run /alduin admin commands. You can do this later with `alduin admin bootstrap`.',
      initialValue: true,
    })
  );

  if (!wantsBootstrap) return undefined;

  const rawUserId = guard(
    await text({
      message:
        channel.channel === 'telegram' || channel.channel === 'both'
          ? 'Your Telegram user ID (numeric — find via @userinfobot):'
          : 'Owner user ID for this channel:',
      placeholder: '123456789',
      validate: (v) => validateOwnerUserId(v ?? ''),
    })
  );

  return {
    tenantId: defaultTenantId,
    userId: (rawUserId as string).trim(),
  };
}
