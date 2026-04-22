/**
 * DoctorRule interface — every rule is a self-contained check with optional fix.
 *
 * Each rule lives in its own file under src/cli/doctor/rules/ and is
 * plugged into the runner via the barrel export in rules/index.ts.
 *
 */

import type { AlduinConfig } from '../../config/schema/index.js';
import type { ModelCatalog } from '../../catalog/catalog.js';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip' | 'fixed';

export interface DoctorCheckResult {
  /** Machine-readable identifier for this check. */
  id: string;
  /** Human-readable display label. */
  label: string;
  status: CheckStatus;
  /** One-line detail string (empty string for clean passes). */
  detail: string;
  /** True when --fix can automatically remediate a failure. */
  fixable: boolean;
}

/** Shared context passed to every rule by the runner. */
export interface DoctorContext {
  /** Absolute path to alduin.yaml. */
  configPath: string;
  /** Absolute path to vault database. */
  vaultPath: string;
  /** Project root directory. */
  root: string;
  /** Parsed config (null if config failed to load). */
  config: AlduinConfig | null;
  /** Loaded model catalog (null if catalog failed to load). */
  catalog: ModelCatalog | null;
  /** Environment variable map. */
  env: Record<string, string | undefined>;
  /** Whether vault-dependent checks should be skipped. */
  skipVault: boolean;
  /** Whether the runner should attempt auto-fixes. */
  fix: boolean;
}

/**
 * A single doctor rule.
 *
 * Rules are stateless — the runner constructs a DoctorContext once and
 * passes it to every rule's check() and fix() methods.
 */
export interface DoctorRule {
  /** Machine-readable ID (matches DoctorCheckResult.id). */
  readonly id: string;
  /** Human-readable label. */
  readonly label: string;

  /** Run the check. Must never throw. */
  check(ctx: DoctorContext): DoctorCheckResult | Promise<DoctorCheckResult>;

  /**
   * Attempt to fix the issue. Returns a human-readable log line.
   * Only called when check() returned a non-pass status and fixable: true.
   * May return null if the rule refuses to auto-fix (e.g. deprecated models).
   */
  fix?(ctx: DoctorContext): string | null | Promise<string | null>;
}
