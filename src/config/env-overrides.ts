import { childSchema, coerceValue, setDeep, validatePath } from './path-utils.js';

export { childSchema, coerceValue, setDeep, validatePath };

/**
 * Apply `ALDUIN_FOO__BAR__BAZ=value` environment variable overrides to a raw
 * (pre-Zod) config object.
 *
 * Transformation rules:
 *  1. Only vars starting with `ALDUIN_` are processed.
 *  2. The prefix is stripped and the remainder is split on `__` (double
 *     underscore) to form path segments.
 *  3. Each segment is lowercased to match schema field names
 *     (e.g. `DAILY_LIMIT_USD` → `daily_limit_usd`).
 *  4. Paths are validated against the `alduinConfigSchema`. Unknown paths
 *     throw an error.
 *  5. Values are coerced to number/boolean where the schema expects them;
 *     everything else stays a string.
 *
 * Mutates `raw` in place and returns it for chaining.
 *
 * @throws {Error} if a ALDUIN_* variable maps to a path that is not in the schema.
 */
/**
 * ALDUIN_* env vars that are infrastructure secrets / flags, not config-path
 * overrides.  These must be skipped by the override parser so that setting
 * e.g. ALDUIN_AUDIT_HMAC_KEY does not crash loadConfig with "unknown path".
 *
 * Keep in sync with the display-filter in src/cli/doctor.ts
 * (checkEnvOverridesParse).
 */
const INFRA_ENV_VARS: ReadonlySet<string> = new Set([
  'ALDUIN_VAULT_SECRET',
  'ALDUIN_AUDIT_HMAC_KEY',
  'ALDUIN_WEBHOOK_SECRET',
  'ALDUIN_ALLOW_LOCAL_INGESTION',
  'ALDUIN_TRUST_PROXY',
  'ALDUIN_ALLOW_UNSIGNED',
  'ALDUIN_PLUGIN_HOT_RELOAD',
]);

export function applyEnvOverrides(
  raw: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): Record<string, unknown> {
  const PREFIX = 'ALDUIN_';

  for (const [envKey, envValue] of Object.entries(env)) {
    if (!envKey.startsWith(PREFIX)) continue;
    if (envValue === undefined || envValue === '') continue;
    if (INFRA_ENV_VARS.has(envKey)) continue;

    const segments = envKey
      .slice(PREFIX.length)
      .split('__')
      .map((s) => s.toLowerCase());

    if (segments.length === 0 || segments.some((s) => s === '')) {
      throw new Error(
        `env-override: malformed env var "${envKey}" — path segments must be non-empty.`
      );
    }

    const leafSchema = validatePath(segments, 'env-override');
    const coerced = coerceValue(envValue, leafSchema);
    setDeep(raw, segments, coerced);
  }

  return raw;
}
