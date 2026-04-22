import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { alduinConfigSchema } from './schema/index.js';
import type { AlduinConfig } from './schema/index.js';
import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';
import { applyEnvOverrides } from './env-overrides.js';
import { resolveSecrets } from '../secrets/ref.js';
import type { CredentialVault } from '../secrets/vault.js';

/** Structured error type for config loading failures. */
export interface ConfigError {
  /** The specific field that caused the error, if applicable. */
  field?: string;
  message: string;
  code: 'file_not_found' | 'parse_error' | 'validation_error' | 'override_error';
}

/**
 * Load and validate a Alduin config from a YAML file.
 *
 * Composition order (each stage mutates the raw object before Zod sees it):
 *   1. Read + parse YAML
 *   2. Apply ALDUIN_*__ env-var path overrides
 *   3. Resolve SecretRef values from the vault (if a vault is supplied)
 *   4. Zod schema validation → typed AlduinConfig
 *
 * Returns `ok(config)` on success, or `err(ConfigError)` on:
 *   - File not found
 *   - YAML parse failure
 *   - Unknown env-override path
 *   - Zod schema validation failure
 *
 * After validation, warns (but does not fail) if provider `api_key_env`
 * references a missing environment variable.
 *
 * @param filePath  Path to the YAML config file.
 * @param vault     Optional CredentialVault for resolving SecretRef fields.
 * @param env       Environment variable map (defaults to process.env).
 */
export function loadConfig(
  filePath: string,
  vault: CredentialVault | null = null,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): Result<AlduinConfig, ConfigError> {
  // ── Stage 1: read + parse YAML ──────────────────────────────────────────────
  let rawYaml: string;
  try {
    rawYaml = readFileSync(filePath, 'utf-8');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err({
      message: `Config file not found: ${filePath} — ${message}`,
      code: 'file_not_found',
    });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml, { maxAliasCount: 100 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err({
      message: `Failed to parse YAML: ${message}`,
      code: 'parse_error',
    });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return err({
      message: 'Config file must contain a YAML object at the top level.',
      code: 'parse_error',
    });
  }

  const raw = parsed as Record<string, unknown>;

  // ── Stage 2: env-var path overrides ─────────────────────────────────────────
  try {
    applyEnvOverrides(raw, env);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err({ message, code: 'override_error' });
  }

  // ── Stage 3: vault SecretRef resolution ─────────────────────────────────────
  resolveSecrets(raw, vault);

  // ── Stage 4: Zod validation ─────────────────────────────────────────────────
  const validated = alduinConfigSchema.safeParse(raw);
  if (!validated.success) {
    return err(formatZodError(validated.error));
  }

  const config = validated.data as AlduinConfig;

  // Warn about missing environment variables — don't fail
  for (const [providerName, providerCfg] of Object.entries(config.providers)) {
    if (providerCfg.api_key_env && !env[providerCfg.api_key_env]) {
      console.warn(
        `[Alduin] Warning: Provider "${providerName}" references env var ` +
          `"${providerCfg.api_key_env}" which is not set. ` +
          `The provider will fail at runtime.`
      );
    }
  }

  return ok(config);
}

/** Format a ZodError into a ConfigError, extracting the first issue. */
function formatZodError(error: ZodError): ConfigError {
  const first = error.issues[0];
  if (!first) {
    return { message: 'Unknown validation error', code: 'validation_error' };
  }

  const field =
    first.path.length > 0 ? first.path.join('.') : undefined;

  return {
    field,
    message: field ? `${field}: ${first.message}` : first.message,
    code: 'validation_error',
  };
}
