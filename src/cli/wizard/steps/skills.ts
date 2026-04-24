/**
 * Step 6 — Skills selection.
 *
 * Scans the skills/ directory for curated skills, parses frontmatter,
 * and presents a multi-select with all enabled by default. Each skill
 * shows its executor role tag to connect model choices to real usage.
 */

import { log, multiselect, note } from '@clack/prompts';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { guard } from '../helpers.js';
import type { SkillInfo, SkillsAnswers } from '../types.js';

// ── Frontmatter parsing ───────────────────────────────────────────────────────

/** Minimal frontmatter extraction — just what we need for the wizard. */
function parseFrontmatter(content: string): {
  id?: string;
  description?: string;
  model_hints?: { prefer?: string[] };
} | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) return null;

  const yaml = match[1];
  const result: Record<string, unknown> = {};

  // Simple line-by-line YAML parsing for flat fields
  for (const line of yaml.split('\n')) {
    const kvMatch = line.match(/^(\w[\w_]*)\s*:\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1]!;
      let val: string | boolean = kvMatch[2]!.trim();
      // Strip quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (val === 'true') val = true;
      if (val === 'false') val = false;
      result[key] = val;
    }
  }

  return {
    id: typeof result['id'] === 'string' ? result['id'] : undefined,
    description: typeof result['description'] === 'string' ? result['description'] : undefined,
  };
}

/** Guess executor role from skill ID and model hints. */
function guessExecutorRole(skillId: string): string {
  if (skillId.includes('code') || skillId.includes('review')) return 'code';
  if (skillId.includes('research')) return 'research';
  if (skillId.includes('summarize') || skillId.includes('rewrite') || skillId.includes('content'))
    return 'content';
  if (skillId.includes('extract') || skillId.includes('quick')) return 'quick';
  if (skillId.includes('plan')) return 'orchestrator';
  return 'content'; // default
}

// ── Skill scanning ────────────────────────────────────────────────────────────

export function scanSkills(skillsDir: string): SkillInfo[] {
  if (!existsSync(skillsDir)) return [];

  const skills: SkillInfo[] = [];

  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const entryPath = join(skillsDir, entry);
    try {
      const st = statSync(entryPath);
      if (!st.isDirectory()) continue;

      // Look for SKILL.md inside the directory
      const skillMd = join(entryPath, 'SKILL.md');
      if (!existsSync(skillMd)) continue;

      const content = readFileSync(skillMd, 'utf-8');
      const fm = parseFrontmatter(content);
      if (!fm?.id) continue;

      skills.push({
        id: fm.id,
        description: fm.description ?? `${fm.id} skill`,
        executorRole: guessExecutorRole(fm.id),
      });
    } catch {
      continue;
    }
  }

  return skills;
}

// ── Executor role labels ──────────────────────────────────────────────────────

const EXECUTOR_LABELS: Record<string, string> = {
  code: 'code executor',
  research: 'research executor',
  content: 'content executor',
  quick: 'quick executor',
  orchestrator: 'orchestrator',
};

// ── UI ────────────────────────────────────────────────────────────────────────

export async function runSkillsSelection(skillsDir: string): Promise<SkillsAnswers> {
  const availableSkills = scanSkills(skillsDir);

  if (availableSkills.length === 0) {
    log.warn('No curated skills found. Skills can be added later via `alduin skills list`.');
    return { enabledSkills: [], availableSkills: [] };
  }

  log.info(`Found ${availableSkills.length} curated skill(s):`);

  const selected = guard(
    await multiselect<string>({
      message: 'Select which skills to enable: (space to select, enter to confirm)',
      options: availableSkills.map((s) => {
        const roleLabel = EXECUTOR_LABELS[s.executorRole] ?? s.executorRole;
        return {
          label: `${s.id}`,
          value: s.id,
          hint: `${s.description}  [${roleLabel}]`,
        };
      }),
      initialValues: availableSkills.map((s) => s.id),
      required: false,
    })
  );

  const enabledCount = selected.length;
  const totalCount = availableSkills.length;

  if (enabledCount === totalCount) {
    log.success('All skills enabled.');
  } else if (enabledCount === 0) {
    log.info('No skills enabled. Enable them later via `alduin skills list`.');
  } else {
    log.success(`${enabledCount}/${totalCount} skills enabled.`);
  }

  note(
    'Disabled skills can be re-enabled at any time:\n  alduin skills list',
    'Skills management'
  );

  return { enabledSkills: selected, availableSkills };
}
