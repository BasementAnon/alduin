import { loadConfig } from '../config/loader.js';
import { loadCatalog } from '../catalog/catalog.js';
import { probeProviders, computeDiff } from '../catalog/sync.js';
import { diffConfigVsCatalog, formatDiff } from '../catalog/diff.js';
import {
  proposeUpgrades,
  runSmokeTest,
  applyUpgrades,
  formatUpgradeReport,
} from '../catalog/upgrade.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { AlduinConfig } from '../config/types.js';

/**
 * Entry point for `alduin models <subcommand>`.
 */
export async function handleModelsCommand(
  subcommand: string,
  configPath: string,
  flags: { dryRun?: boolean; model?: string }
): Promise<void> {
  const configResult = loadConfig(configPath);
  if (!configResult.ok) {
    console.error(`Config error: ${configResult.error.message}`);
    process.exit(1);
  }
  const config = configResult.value;

  const catalogResult = loadCatalog();
  if (!catalogResult.ok) {
    console.error(`Catalog error: ${catalogResult.error.message}`);
    process.exit(1);
  }
  const catalog = catalogResult.value;

  switch (subcommand) {
    case 'sync': {
      console.log('Probing provider /models endpoints…');
      const probes = await probeProviders(config);
      for (const probe of probes) {
        if (probe.error) {
          console.log(`  ${probe.provider}: error — ${probe.error}`);
        } else {
          console.log(`  ${probe.provider}: ${probe.models.length} models found`);
        }
      }

      const diffs = computeDiff(catalog.getRawData(), probes);
      if (diffs.length === 0) {
        console.log('\nCatalog is up to date. No new or removed models found.');
      } else {
        console.log(`\n${diffs.length} change(s) detected:`);
        for (const d of diffs) {
          const icon = d.status === 'new' ? '+' : d.status === 'removed' ? '-' : '~';
          console.log(`  ${icon} ${d.model}: ${d.details ?? d.status}`);
        }
      }
      break;
    }

    case 'diff': {
      const result = diffConfigVsCatalog(config, catalog);
      console.log(formatDiff(result));
      break;
    }

    case 'upgrade': {
      const proposals = proposeUpgrades(config, catalog);

      if (proposals.length === 0) {
        console.log('No upgrades available — all pinned models are current.');
        return;
      }

      console.log(formatUpgradeReport(proposals, flags.dryRun ?? false));

      if (flags.dryRun) {
        console.log('\nDry run complete. No changes made.');
        return;
      }

      // Run smoke tests
      console.log('\nRunning smoke tests…');
      const registry = new ProviderRegistry();
      for (const p of proposals) {
        const test = await runSmokeTest(p.proposed_model, registry);
        p.smoke_test_passed = test.passed;
        p.smoke_test_error = test.error;
        const icon = test.passed ? '✓' : '✗';
        console.log(`  ${icon} ${p.proposed_model}: ${test.passed ? 'passed' : test.error}`);
      }

      const passing = proposals.filter((p) => p.smoke_test_passed);
      if (passing.length === 0) {
        console.log('\nNo proposals passed smoke tests. No changes made.');
        return;
      }

      const { applied, auditPath } = applyUpgrades(configPath, proposals);
      console.log(`\n${applied} upgrade(s) applied. Audit log: ${auditPath}`);
      break;
    }

    default:
      console.log(`Unknown models subcommand: ${subcommand}`);
      console.log('Usage: alduin models [sync|diff|upgrade] [--dry-run] [--model <id>]');
  }
}
