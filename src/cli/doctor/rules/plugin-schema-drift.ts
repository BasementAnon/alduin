/**
 * Rule: plugin-schema-drift — plugin alduin.plugin.json manifests validate
 * against the current AlduinPluginManifest schema.
 *
 * Fixable: prints a regenerate hint (actual schema regen is a separate step).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorRule, DoctorCheckResult, DoctorContext } from '../rule.js';
import { alduinPluginManifestSchema } from '@alduin/plugin-sdk';

/** Scan a directory of plugins and validate each manifest. */
function scanPluginDir(dir: string): { valid: string[]; invalid: Array<{ id: string; error: string }> } {
  const valid: string[] = [];
  const invalid: Array<{ id: string; error: string }> = [];

  if (!existsSync(dir)) return { valid, invalid };

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { valid, invalid };
  }

  for (const name of entries) {
    const manifestPath = join(dir, name, 'alduin.plugin.json');
    if (!existsSync(manifestPath)) continue;

    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const result = alduinPluginManifestSchema.safeParse(raw);
      if (result.success) {
        valid.push(name);
      } else {
        const firstIssue = result.error.issues[0];
        invalid.push({
          id: name,
          error: firstIssue ? `${firstIssue.path.join('.')}: ${firstIssue.message}` : 'unknown',
        });
      }
    } catch (e) {
      invalid.push({
        id: name,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { valid, invalid };
}

export const pluginSchemaDriftRule: DoctorRule = {
  id: 'plugin-schema-drift',
  label: 'Plugin manifests valid',

  check(ctx: DoctorContext): DoctorCheckResult {
    const builtinDir = join(ctx.root, 'plugins', 'builtin');
    const { valid, invalid } = scanPluginDir(builtinDir);

    if (invalid.length === 0 && valid.length === 0) {
      return { id: this.id, label: this.label, status: 'skip', detail: 'No plugins found', fixable: false };
    }

    if (invalid.length === 0) {
      return {
        id: this.id, label: this.label, status: 'pass',
        detail: `${valid.length} plugin${valid.length === 1 ? '' : 's'} OK`,
        fixable: false,
      };
    }

    const details = invalid.map((i) => `${i.id}: ${i.error}`).join('; ');
    return {
      id: this.id, label: this.label, status: 'warn',
      detail: `Schema drift in: ${details}`,
      fixable: false, // cannot auto-fix manifest content
    };
  },
};
