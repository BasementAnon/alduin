import type { AlduinConfig } from '../config/types.js';
import type { ModelCatalog } from './catalog.js';

/** A single diff line between config pins and catalog state */
export interface PinDiffEntry {
  model: string;
  field: string;
  config_value: string;
  catalog_value: string;
}

/**
 * Compare current pinned model strings in config against the loaded catalog.
 * Produces a human-readable diff.
 */
export function diffConfigVsCatalog(
  config: AlduinConfig,
  catalog: ModelCatalog
): { valid: PinDiffEntry[]; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const diffs: PinDiffEntry[] = [];

  // Collect all model strings referenced in config
  const referencedModels = new Set<string>();
  referencedModels.add(config.orchestrator.model);
  for (const exec of Object.values(config.executors)) {
    referencedModels.add(exec.model);
  }
  if (config.fallbacks) {
    for (const [primary, chain] of Object.entries(config.fallbacks)) {
      referencedModels.add(primary);
      for (const fallback of chain) {
        referencedModels.add(fallback);
      }
    }
  }
  if (config.budgets.per_model_limits) {
    for (const model of Object.keys(config.budgets.per_model_limits)) {
      referencedModels.add(model);
    }
  }
  if (config.memory?.cold_embedding_model) {
    referencedModels.add(config.memory.cold_embedding_model);
  }

  for (const model of referencedModels) {
    if (!catalog.has(model)) {
      errors.push(`Model "${model}" is referenced in config but not found in catalog.`);
      continue;
    }

    if (catalog.isDeprecated(model)) {
      warnings.push(`Model "${model}" is deprecated. Consider upgrading.`);
    }

    const result = catalog.getModel(model);
    if (!result.ok && result.error.code === 'sunset') {
      errors.push(result.error.message);
    }
  }

  // Check catalog_version match
  if (config.catalog_version && config.catalog_version !== catalog.version) {
    warnings.push(
      `Config catalog_version "${config.catalog_version}" does not match loaded catalog "${catalog.version}".`
    );
  }

  return { valid: diffs, warnings, errors };
}

/** Format diff results as a human-readable string */
export function formatDiff(result: ReturnType<typeof diffConfigVsCatalog>): string {
  const lines: string[] = [];

  if (result.errors.length > 0) {
    lines.push('ERRORS:');
    for (const e of result.errors) {
      lines.push(`  ✗ ${e}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push('WARNINGS:');
    for (const w of result.warnings) {
      lines.push(`  ⚠ ${w}`);
    }
  }

  if (result.errors.length === 0 && result.warnings.length === 0) {
    lines.push('All pinned models are valid and current.');
  }

  return lines.join('\n');
}
