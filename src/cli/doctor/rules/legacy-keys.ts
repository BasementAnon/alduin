/**
 * Rule: legacy-keys — renames config keys that changed between
 * the OpenClaw → Alduin migration (Phases 1–5).
 *
 * Fixable: rewrites the YAML in-place with the new key paths.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import type { DoctorRule, DoctorCheckResult, DoctorContext } from '../rule.js';

/**
 * Keys that were renamed between config schema versions.
 * Shape: { 'old.dot.path': 'new.dot.path' }.
 *
 * Phase 1: vault was introduced; raw secrets in config are now SecretRefs.
 * Phase 2: plugin system replaced inline provider config.
 * Phase 3: orchestrator gained recursion config.
 * Phase 5: streaming + tool config moved under providers block.
 */
export const LEGACY_KEY_RENAMES: Record<string, string> = {
  // Phase 2 — provider config restructured
  'providers.anthropic_api_key': 'providers.anthropic.credentials.api_key',
  'providers.openai_api_key': 'providers.openai.credentials.api_key',
  'providers.openrouter_api_key': 'providers.openrouter.credentials.api_key',

  // Phase 3 — orchestrator recursion fields
  'orchestrator.max_sub_tasks': 'orchestrator.max_recursion_depth',
  'orchestrator.allow_delegation': 'orchestrator.allow_sub_orchestration',

  // Phase 5 — streaming config
  'executors.*.stream_timeout_ms': 'executors.*.streaming.timeout_ms',
  'executors.*.stream_throttle_ms': 'executors.*.streaming.throttle_ms',
};

/** Get a nested value from an object by dot path. Supports literal keys (no wildcards). */
function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Set a nested value on an object by dot path. Creates intermediate objects as needed. */
function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

/** Delete a nested key by dot path. */
function deleteByPath(obj: Record<string, unknown>, path: string): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (typeof current[part] !== 'object' || current[part] === null) return;
    current = current[part] as Record<string, unknown>;
  }
  delete current[parts[parts.length - 1]!];
}

/**
 * Find legacy keys present in the raw config.
 * Returns array of [oldPath, newPath] pairs that exist.
 * Skips wildcard entries (those are documented but not auto-migrated on top-level).
 */
function detectLegacyKeys(
  raw: Record<string, unknown>,
): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (const [oldPath, newPath] of Object.entries(LEGACY_KEY_RENAMES)) {
    if (oldPath.includes('*')) continue; // wildcard rules are informational only
    const value = getByPath(raw, oldPath);
    if (value !== undefined) {
      found.push([oldPath, newPath]);
    }
  }
  return found;
}

export const legacyKeysRule: DoctorRule = {
  id: 'legacy-keys',
  label: 'Legacy config keys renamed',

  check(ctx: DoctorContext): DoctorCheckResult {
    if (!existsSync(ctx.configPath)) {
      return { id: this.id, label: this.label, status: 'skip', detail: 'Config not found', fixable: false };
    }

    let raw: Record<string, unknown>;
    try {
      raw = parseYaml(readFileSync(ctx.configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      return { id: this.id, label: this.label, status: 'skip', detail: 'Config parse error', fixable: false };
    }

    const found = detectLegacyKeys(raw);
    if (found.length === 0) {
      return { id: this.id, label: this.label, status: 'pass', detail: '', fixable: false };
    }

    const details = found.map(([o, n]) => `${o} → ${n}`).join('; ');
    return {
      id: this.id, label: this.label, status: 'warn',
      detail: `Legacy keys: ${details}`,
      fixable: true,
    };
  },

  fix(ctx: DoctorContext): string | null {
    if (!existsSync(ctx.configPath)) return null;
    let raw: Record<string, unknown>;
    try {
      raw = parseYaml(readFileSync(ctx.configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      return null;
    }

    const found = detectLegacyKeys(raw);
    if (found.length === 0) return null;

    for (const [oldPath, newPath] of found) {
      const value = getByPath(raw, oldPath);
      setByPath(raw, newPath, value);
      deleteByPath(raw, oldPath);
    }

    writeFileSync(ctx.configPath, toYaml(raw), 'utf-8');
    return `Renamed ${found.length} legacy key(s): ${found.map(([o]) => o).join(', ')}`;
  },
};
