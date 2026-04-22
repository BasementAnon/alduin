/**
 * Rule: catalog-version — config.catalog_version matches loaded catalog.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import type { DoctorRule, DoctorCheckResult, DoctorContext } from '../rule.js';

export const catalogVersionRule: DoctorRule = {
  id: 'catalog-version',
  label: 'Catalog version pinned',

  check(ctx: DoctorContext): DoctorCheckResult {
    if (!ctx.config) {
      return { id: this.id, label: this.label, status: 'skip', detail: 'Config not loaded', fixable: false };
    }
    if (!ctx.catalog) {
      return { id: this.id, label: this.label, status: 'skip', detail: 'Catalog not loaded', fixable: false };
    }
    if (!ctx.config.catalog_version) {
      return {
        id: this.id, label: this.label, status: 'warn',
        detail: `Missing — current catalog is ${ctx.catalog.version}`,
        fixable: true,
      };
    }
    if (ctx.config.catalog_version !== ctx.catalog.version) {
      return {
        id: this.id, label: this.label, status: 'warn',
        detail: `Config pins ${ctx.config.catalog_version}, catalog is ${ctx.catalog.version}`,
        fixable: true,
      };
    }
    return { id: this.id, label: this.label, status: 'pass', detail: ctx.config.catalog_version, fixable: false };
  },

  fix(ctx: DoctorContext): string | null {
    if (!ctx.catalog) return null;
    const raw = parseYaml(readFileSync(ctx.configPath, 'utf-8')) as Record<string, unknown>;
    raw['catalog_version'] = ctx.catalog.version;
    writeFileSync(ctx.configPath, toYaml(raw), 'utf-8');
    // Update the in-memory config so re-checks see the fix
    if (ctx.config) {
      (ctx.config as Record<string, unknown>)['catalog_version'] = ctx.catalog.version;
    }
    return `catalog_version set to ${ctx.catalog.version}`;
  },
};
