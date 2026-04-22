import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import type { AlduinConfig } from '../config/types.js';
import type { ModelCatalog, ModelEntry } from './catalog.js';
import { ProviderRegistry } from '../providers/registry.js';

/** A single proposed pin upgrade */
export interface UpgradeProposal {
  current_model: string;
  proposed_model: string;
  pricing_delta: { input: number; output: number };
  context_window_delta: number;
  smoke_test_passed: boolean;
  smoke_test_error?: string;
}

/**
 * Propose model upgrades by comparing current config pins against catalog.
 * For now, this validates that current pins exist and reports their status.
 * True "upgrade to latest stable" requires probed data from sync.ts.
 */
export function proposeUpgrades(
  config: AlduinConfig,
  catalog: ModelCatalog
): UpgradeProposal[] {
  const proposals: UpgradeProposal[] = [];
  const models = new Set<string>();
  models.add(config.orchestrator.model);
  for (const exec of Object.values(config.executors)) {
    models.add(exec.model);
  }

  for (const model of models) {
    const entry = catalog.getModel(model);
    if (!entry.ok) continue;

    if (entry.value.deprecated) {
      proposals.push({
        current_model: model,
        proposed_model: model, // would be the replacement once sync data is available
        pricing_delta: { input: 0, output: 0 },
        context_window_delta: 0,
        smoke_test_passed: false,
        smoke_test_error: 'Deprecated — replacement discovery requires `alduin models sync`',
      });
    }
  }

  return proposals;
}

/**
 * Run a cheap smoke test against a model: send one short completion
 * to verify the provider responds. Returns true on success.
 */
export async function runSmokeTest(
  model: string,
  registry: ProviderRegistry
): Promise<{ passed: boolean; error?: string }> {
  const provider = registry.resolveProvider(model);
  if (!provider) {
    return { passed: false, error: `No provider registered for ${model}` };
  }

  const modelName = registry.resolveModelName(model);

  try {
    const result = await provider.complete({
      model: modelName,
      messages: [{ role: 'user', content: 'Respond with the word "ok".' }],
      max_tokens: 10,
    });

    return result.ok
      ? { passed: true }
      : { passed: false, error: result.error.message };
  } catch (e) {
    return { passed: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Apply upgrade proposals to a config file.
 * Reads the YAML, replaces model strings, writes it back.
 * Appends an audit log entry to .alduin/audit.log.
 */
export function applyUpgrades(
  configPath: string,
  proposals: UpgradeProposal[]
): { applied: number; auditPath: string } {
  const passingProposals = proposals.filter((p) => p.smoke_test_passed);
  if (passingProposals.length === 0) {
    return { applied: 0, auditPath: '' };
  }

  let configContent = readFileSync(configPath, 'utf-8');

  for (const proposal of passingProposals) {
    if (proposal.current_model !== proposal.proposed_model) {
      configContent = configContent.replaceAll(
        proposal.current_model,
        proposal.proposed_model
      );
    }
  }

  writeFileSync(configPath, configContent, 'utf-8');

  // Audit log
  const auditDir = join(dirname(configPath), '.alduin');
  if (!existsSync(auditDir)) {
    mkdirSync(auditDir, { recursive: true });
  }
  const auditPath = join(auditDir, 'audit.log');
  const entry = [
    `[${new Date().toISOString()}] Model upgrade applied`,
    ...passingProposals.map(
      (p) => `  ${p.current_model} → ${p.proposed_model}`
    ),
    '',
  ].join('\n');
  appendFileSync(auditPath, entry + '\n', 'utf-8');

  return { applied: passingProposals.length, auditPath };
}

/**
 * Format upgrade proposals as a human-readable report.
 */
export function formatUpgradeReport(proposals: UpgradeProposal[], dryRun: boolean): string {
  if (proposals.length === 0) {
    return 'No upgrades available — all pinned models are current.';
  }

  const lines: string[] = [];
  lines.push(dryRun ? 'DRY RUN — proposed upgrades:' : 'Upgrade proposals:');
  lines.push('');

  for (const p of proposals) {
    const status = p.smoke_test_passed ? '✓' : '✗';
    lines.push(`  ${status} ${p.current_model} → ${p.proposed_model}`);
    if (p.pricing_delta.input !== 0 || p.pricing_delta.output !== 0) {
      lines.push(
        `    Pricing: input ${p.pricing_delta.input > 0 ? '+' : ''}${p.pricing_delta.input}, ` +
        `output ${p.pricing_delta.output > 0 ? '+' : ''}${p.pricing_delta.output} per MTok`
      );
    }
    if (p.context_window_delta !== 0) {
      lines.push(
        `    Context window: ${p.context_window_delta > 0 ? '+' : ''}${p.context_window_delta.toLocaleString()}`
      );
    }
    if (p.smoke_test_error) {
      lines.push(`    Error: ${p.smoke_test_error}`);
    }
  }

  return lines.join('\n');
}
