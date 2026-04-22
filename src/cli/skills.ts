/**
 * CLI handler for `alduin skills` subcommands.
 *
 *   alduin skills list
 *   alduin skills show <id>
 *   alduin skills add <path-or-url>
 *   alduin skills update [<id>]
 *   alduin skills remove <id>
 */

import { existsSync, mkdirSync, cpSync, rmSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { SkillRegistry } from '../skills/registry.js';
import { parseSkillFrontmatter } from '../skills/frontmatter.js';
import { readFileSync } from 'fs';

/** Default curated skills directory (relative to project root) */
const CURATED_SKILLS_DIR = resolve(import.meta.dirname ?? '.', '../../skills');

/** User skills directory */
const USER_SKILLS_DIR = join(homedir(), '.alduin', 'skills');

/**
 * Build a merged registry scanning both curated and user skills.
 * User skills shadow curated skills (same id → user wins, with warning).
 */
function buildMergedRegistry(): {
  curated: SkillRegistry;
  user: SkillRegistry;
  shadows: string[];
} {
  const curated = new SkillRegistry(CURATED_SKILLS_DIR, { rejectPinnedModels: true });
  curated.loadManifest();

  const shadows: string[] = [];

  // Load user skills if directory exists
  const user = new SkillRegistry(USER_SKILLS_DIR, { rejectPinnedModels: false });
  if (existsSync(USER_SKILLS_DIR)) {
    // Suppress warnings for user dir by loading silently
    user.loadManifest();

    // Detect shadows
    for (const id of user.listSkills()) {
      if (curated.has(id)) {
        shadows.push(id);
      }
    }
  }

  return { curated, user, shadows };
}

/** Merge skill lists (user wins on conflicts) */
function allSkillIds(curated: SkillRegistry, user: SkillRegistry): string[] {
  const ids = new Set<string>();
  for (const id of curated.listSkills()) ids.add(id);
  for (const id of user.listSkills()) ids.add(id);
  return [...ids].sort();
}

// ── Subcommand handlers ──────────────────────────────────────────────────────

function listSkills(): void {
  const { curated, user, shadows } = buildMergedRegistry();
  const ids = allSkillIds(curated, user);

  if (ids.length === 0) {
    console.log('No skills installed.');
    return;
  }

  console.log(`\n  Alduin Skills (${ids.length})\n`);

  for (const id of ids) {
    const isUser = user.has(id);
    const isShadow = shadows.includes(id);
    const manifest = isUser ? user.getManifest(id) : curated.getManifest(id);
    if (!manifest) continue;

    const source = isUser ? (isShadow ? '(user, shadows curated)' : '(user)') : '(curated)';
    const subOrch = manifest.allow_sub_orchestration ? ' [recursive]' : '';
    const fallback = manifest.model_hints.fallback_local ? ' [local-ok]' : '';

    console.log(`  ${id}  ${source}${subOrch}${fallback}`);
    console.log(`    ${manifest.description}`);
  }

  if (shadows.length > 0) {
    console.log(`\n  ⚠ ${shadows.length} user skill(s) shadow curated skills: ${shadows.join(', ')}`);
  }

  console.log('');
}

function showSkill(id: string): void {
  const { curated, user } = buildMergedRegistry();

  // User skills take priority
  const registry = user.has(id) ? user : curated;

  const manifest = registry.getManifest(id);
  if (!manifest) {
    console.error(`Skill "${id}" not found. Run \`alduin skills list\` to see available skills.`);
    process.exit(1);
  }

  const body = registry.getBody(id);
  const source = user.has(id) ? 'user' : 'curated';

  console.log(`\n  Skill: ${manifest.id} (${source})\n`);
  console.log(`  Description:  ${manifest.description}`);
  console.log(`  Inputs:       ${manifest.inputs.map((i) => `${i.name}${i.required ? '*' : ''} (${i.type})`).join(', ') || 'none'}`);
  console.log(`  Model hints:  prefer=[${manifest.model_hints.prefer.join(', ')}], fallback_local=${manifest.model_hints.fallback_local}`);
  console.log(`  Sub-orch:     ${manifest.allow_sub_orchestration}`);

  if (manifest.env_required.length > 0) {
    console.log(`  Env required: ${manifest.env_required.join(', ')}`);
  }
  if (manifest.os) {
    console.log(`  OS:           ${manifest.os}`);
  }
  if (manifest.requires_connectors.length > 0) {
    console.log(`  Connectors:   ${manifest.requires_connectors.join(', ')}`);
  }
  console.log(`  Sandbox:      fs=${manifest.allow_fs}, net=${manifest.allow_net}`);

  if (body) {
    console.log(`\n${body}`);
  }

  console.log('');
}

export function addSkill(pathOrUrl: string): void {
  // Only local paths supported for now (git URLs are Phase 5+)
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://') || pathOrUrl.startsWith('git@')) {
    console.error('Git URL installs are not yet supported. Use a local file path.');
    process.exit(1);
  }

  const sourcePath = resolve(pathOrUrl);
  if (!existsSync(sourcePath)) {
    console.error(`File not found: ${sourcePath}`);
    process.exit(1);
  }

  // Stat first — branch on file vs. directory. Previous implementation called
  // `readdirSync` unconditionally, which threw ENOTDIR on a plain file path.
  const stat = statSync(sourcePath);
  const isFile = stat.isFile();
  const isDir = stat.isDirectory();

  if (!isFile && !isDir) {
    console.error(`Not a regular file or directory: ${sourcePath}`);
    process.exit(1);
  }

  // Locate the SKILL.md inside a directory source, or use the file directly.
  const manifestPath = isFile ? sourcePath : join(sourcePath, 'SKILL.md');
  if (!existsSync(manifestPath)) {
    console.error(
      isFile
        ? `File not found: ${manifestPath}`
        : `Directory does not contain SKILL.md: ${sourcePath}`
    );
    process.exit(1);
  }

  // Parse and validate the skill
  const content = readFileSync(manifestPath, 'utf-8');
  const result = parseSkillFrontmatter(content, manifestPath);
  if (!result.ok) {
    console.error(`Invalid skill file: ${result.error}`);
    process.exit(1);
  }

  const id = result.data.frontmatter.id;

  // Create user skills directory if needed
  mkdirSync(USER_SKILLS_DIR, { recursive: true });

  // Check for curated shadow
  const curated = new SkillRegistry(CURATED_SKILLS_DIR, { rejectPinnedModels: true });
  curated.loadManifest();
  if (curated.has(id)) {
    console.warn(`⚠ Skill "${id}" shadows a curated skill with the same name.`);
  }

  const targetDir = join(USER_SKILLS_DIR, id);
  mkdirSync(targetDir, { recursive: true });

  if (isFile) {
    // Copy the single file in as SKILL.md
    const targetFile = join(targetDir, 'SKILL.md');
    cpSync(sourcePath, targetFile);
  } else {
    // Copy directory contents (so support files like scripts/, examples/, etc. come along).
    // `cpSync(src, dest, { recursive: true })` copies the *contents* of src into dest
    // when dest already exists as a directory.
    cpSync(sourcePath, targetDir, { recursive: true });
  }

  console.log(`Installed skill "${id}" to ${targetDir}`);
}

function updateSkill(_id?: string): void {
  // For local-only installs, update is a no-op
  console.log('Update is a no-op for locally installed skills.');
  console.log('To update a skill, run: alduin skills remove <id> && alduin skills add <path>');
}

function removeSkill(id: string): void {
  const targetDir = join(USER_SKILLS_DIR, id);
  const targetFile = join(USER_SKILLS_DIR, `${id}.md`);

  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
    console.log(`Removed skill "${id}" from ${targetDir}`);
  } else if (existsSync(targetFile)) {
    rmSync(targetFile);
    console.log(`Removed skill "${id}"`);
  } else {
    // Check if it's a curated skill
    const curated = new SkillRegistry(CURATED_SKILLS_DIR, { rejectPinnedModels: true });
    curated.loadManifest();
    if (curated.has(id)) {
      console.error(`Skill "${id}" is a curated skill and cannot be removed.`);
      process.exit(1);
    }
    console.error(`Skill "${id}" not found in user skills directory.`);
    process.exit(1);
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

export function handleSkillsCommand(args: string[]): void {
  const subcommand = args[0];

  switch (subcommand) {
    case 'list':
    case undefined:
      listSkills();
      break;

    case 'show':
      if (!args[1]) {
        console.error('Usage: alduin skills show <id>');
        process.exit(1);
      }
      showSkill(args[1]);
      break;

    case 'add':
      if (!args[1]) {
        console.error('Usage: alduin skills add <path-or-url>');
        process.exit(1);
      }
      addSkill(args[1]);
      break;

    case 'update':
      updateSkill(args[1]);
      break;

    case 'remove':
      if (!args[1]) {
        console.error('Usage: alduin skills remove <id>');
        process.exit(1);
      }
      removeSkill(args[1]);
      break;

    default:
      console.error(`Unknown skills subcommand: ${subcommand}`);
      console.error('Available: list, show, add, update, remove');
      process.exit(1);
  }
}
