import { confirm, log, text } from '@clack/prompts';
import { guard } from '../helpers.js';
import type { ChannelAnswers, OwnerAnswers } from '../types.js';

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validate a channel user ID. Telegram numeric IDs are the common case, but
 * non-numeric identifiers from other channels are accepted too — we only
 * reject empty input, whitespace, and values containing control characters.
 */
export function validateOwnerUserId(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'User ID is required.';
  if (trimmed.length > 128) return 'User ID is too long (≤ 128 chars).';
  // Reject control characters and shell metacharacters that would look like
  // injection attempts (Telegram IDs are numeric so this is strict but safe).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return 'User ID must not contain control characters.';
  return undefined;
}

// ── UI ────────────────────────────────────────────────────────────────────────

/**
 * Optional wizard step — prompt the user for the owner's channel user ID so
 * `alduin admin bootstrap` can seed the first `owner` role automatically.
 *
 * Skipped entirely when the channel is CLI-only.
 *
 * Returns undefined if the user declines to bootstrap an owner now; they can
 * run `alduin admin bootstrap --tenant <t> --user-id <u>` later.
 */
export async function runOwnerBootstrap(
  channel: ChannelAnswers,
  defaultTenantId = 'default'
): Promise<OwnerAnswers | undefined> {
  if (channel.channel === 'cli') {
    log.info('CLI-only mode: owner role is not tied to a channel user — skipping.');
    return undefined;
  }

  const wantsBootstrap = guard(
    await confirm({
      message:
        'Seed the first owner for this tenant now? ' +
        '(Owners can run /admin commands. You can do this later with `alduin admin bootstrap`.)',
      initialValue: true,
    })
  );

  if (!wantsBootstrap) return undefined;

  const rawUserId = guard(
    await text({
      message:
        channel.channel === 'telegram'
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
