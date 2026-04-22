/**
 * Rule: schema-sync — generated schema file matches source file SHA.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorRule, DoctorCheckResult, DoctorContext } from '../rule.js';

const SCHEMA_SOURCE_FILES = [
  'src/config/schema/secrets.ts',
  'src/config/schema/models.ts',
  'src/config/schema/providers.ts',
  'src/config/schema/channels.ts',
  'src/config/schema/agents.ts',
  'src/config/schema/index.ts',
  'src/config/schema-hints.ts',
];

const GENERATED_SCHEMA_PATH = 'src/config/schema.generated.ts';

function computeInputSha(root: string): string {
  const hash = createHash('sha256');
  for (const rel of SCHEMA_SOURCE_FILES) {
    const abs = join(root, rel);
    if (existsSync(abs)) hash.update(readFileSync(abs));
  }
  return hash.digest('hex').slice(0, 16);
}

function readCommittedSha(root: string): string | null {
  const path = join(root, GENERATED_SCHEMA_PATH);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf-8');
  const m = content.match(/INPUT_SHA\s*=\s*'([0-9a-f]+)'/);
  return m?.[1] ?? null;
}

export const schemaSyncRule: DoctorRule = {
  id: 'schema-in-sync',
  label: 'Generated schema up to date',

  check(ctx: DoctorContext): DoctorCheckResult {
    const committedSha = readCommittedSha(ctx.root);
    if (committedSha === null) {
      return {
        id: this.id, label: this.label, status: 'warn',
        detail: `${GENERATED_SCHEMA_PATH} not found — run \`npm run config:generate\``,
        fixable: true,
      };
    }
    const freshSha = computeInputSha(ctx.root);
    if (committedSha !== freshSha) {
      return {
        id: this.id, label: this.label, status: 'warn',
        detail: `Committed SHA ${committedSha} ≠ fresh ${freshSha} — run \`npm run config:generate\``,
        fixable: true,
      };
    }
    return { id: this.id, label: this.label, status: 'pass', detail: `SHA ${committedSha}`, fixable: false };
  },

  fix(ctx: DoctorContext): string | null {
    try {
      const { execSync } = require('node:child_process') as typeof import('node:child_process');
      execSync('npm run config:generate', { cwd: ctx.root, stdio: 'pipe' });
      return 'Regenerated src/config/schema.generated.ts';
    } catch (e) {
      return `schema-regen failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};
