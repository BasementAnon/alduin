import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { alduinConfigSchema } from '../config/schema/index.js';
import {
  coerceValue,
  deleteDeep,
  getDeep,
  setDeep,
  validatePath,
} from '../config/path-utils.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function readRaw(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) {
    console.error(`alduin config: file not found — ${configPath}`);
    process.exit(1);
  }
  const raw = parseYaml(readFileSync(configPath, 'utf-8'), { maxAliasCount: 100 });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    console.error('alduin config: config file must be a YAML object at the top level.');
    process.exit(1);
  }
  return raw as Record<string, unknown>;
}

function writeRaw(configPath: string, raw: Record<string, unknown>): void {
  writeFileSync(configPath, toYaml(raw), 'utf-8');
}

function parseDotPath(dotPath: string): string[] {
  const segments = dotPath.split('.').filter((s) => s.length > 0);
  if (segments.length === 0) {
    console.error(`alduin config: invalid path "${dotPath}" — must be a dotted field path.`);
    process.exit(1);
  }
  return segments;
}

// ── Subcommand implementations ────────────────────────────────────────────────

/**
 * alduin config get <dotted.path>
 *
 * Reads config.yaml and prints the value at the given path.
 * Prints JSON for objects/arrays, plain string for scalar values.
 */
export function configGet(configPath: string, dotPath: string): void {
  const segments = parseDotPath(dotPath);
  const raw = readRaw(configPath);
  const value = getDeep(raw, segments);
  if (value === undefined) {
    console.error(`alduin config get: path "${dotPath}" not found in ${configPath}`);
    process.exit(1);
  }
  if (typeof value === 'string') {
    console.log(value);
  } else {
    console.log(JSON.stringify(value, null, 2));
  }
}

/**
 * alduin config set <dotted.path> <value>
 *
 * Sets the value at the given path, re-validates the full config with Zod,
 * and writes back to config.yaml only if validation passes.
 */
export function configSet(configPath: string, dotPath: string, rawValue: string): void {
  const segments = parseDotPath(dotPath);

  // Validate path against schema and coerce value
  let leafSchema;
  try {
    leafSchema = validatePath(segments, 'alduin config set');
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  const coerced = coerceValue(rawValue, leafSchema);

  // Apply to raw config
  const raw = readRaw(configPath);
  setDeep(raw, segments, coerced);

  // Full Zod re-validation
  const validated = alduinConfigSchema.safeParse(raw);
  if (!validated.success) {
    const first = validated.error.issues[0];
    const field = first?.path.join('.') ?? '(unknown)';
    const msg = first?.message ?? 'validation failed';
    console.error(`alduin config set: validation error after change — ${field}: ${msg}`);
    console.error('Config file was not modified.');
    process.exit(1);
  }

  writeRaw(configPath, raw);
  console.log(`✓ ${dotPath} = ${JSON.stringify(coerced)}`);
}

/**
 * alduin config unset <dotted.path>
 *
 * Deletes the key at the given path from config.yaml.
 * Writes back even if the result fails validation (useful for removing
 * optional fields); warns if validation fails after the change.
 */
export function configUnset(configPath: string, dotPath: string): void {
  const segments = parseDotPath(dotPath);
  const raw = readRaw(configPath);

  const deleted = deleteDeep(raw, segments);
  if (!deleted) {
    console.error(`alduin config unset: path "${dotPath}" not found in ${configPath}`);
    process.exit(1);
  }

  // Warn (but don't block) if the result is invalid
  const validated = alduinConfigSchema.safeParse(raw);
  if (!validated.success) {
    const first = validated.error.issues[0];
    const field = first?.path.join('.') ?? '(unknown)';
    console.warn(
      `⚠ Warning: config is now invalid after unsetting "${dotPath}" — ` +
        `${field}: ${first?.message ?? 'validation failed'}`
    );
  }

  writeRaw(configPath, raw);
  console.log(`✓ Removed ${dotPath}`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

const USAGE = `\
Usage:
  alduin config get <dotted.path>
  alduin config set <dotted.path> <value>
  alduin config unset <dotted.path>

Examples:
  alduin config get orchestrator.model
  alduin config set budgets.daily_limit_usd 25
  alduin config set routing.pre_classifier false
  alduin config unset memory.redact_pii
`;

/**
 * Route `alduin config <subcommand> ...` invocations.
 */
export function handleConfigCommand(
  args: string[],
  configPath: string
): void {
  const [sub, arg1, arg2] = args;

  switch (sub) {
    case 'get':
      if (!arg1) { console.error('alduin config get: missing <path>\n' + USAGE); process.exit(1); }
      configGet(configPath, arg1);
      break;

    case 'set':
      if (!arg1 || arg2 === undefined) { console.error('alduin config set: missing <path> or <value>\n' + USAGE); process.exit(1); }
      configSet(configPath, arg1, arg2);
      break;

    case 'unset':
      if (!arg1) { console.error('alduin config unset: missing <path>\n' + USAGE); process.exit(1); }
      configUnset(configPath, arg1);
      break;

    default:
      console.error(`alduin config: unknown subcommand "${sub ?? ''}"\n\n${USAGE}`);
      process.exit(1);
  }
}
