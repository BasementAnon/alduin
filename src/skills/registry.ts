/**
 * Lazy-loading skill registry.
 *
 * The orchestrator sees only a compact manifest (<100 tokens per skill).
 * Full skill definitions (prompt body + optional code module) load on
 * first use per task — saving thousands of tokens per orchestrator call.
 *
 * Security: rejects symlinks, enforces path-confinement, caps file size.
 */

import { existsSync, readdirSync, readFileSync, statSync, lstatSync, realpathSync } from 'fs';
import { join, extname, basename, sep } from 'path';
import {
  parseSkillFrontmatter,
  parseSkillYaml,
  findPinnedModel,
  type SkillFrontmatter,
  type ParsedSkillFile,
} from './frontmatter.js';

/** Maximum file size accepted during manifest load (256 KiB). */
const MAX_SKILL_FILE_BYTES = 256 * 1024;

/** A loaded skill entry in the registry */
export interface SkillEntry {
  /** Validated frontmatter fields */
  manifest: SkillFrontmatter;
  /** Absolute path to the source file */
  filePath: string;
  /** Cached full body (null = not yet loaded) */
  _cachedBody: string | null;
}

/**
 * Reject filenames that contain path separators or `..` segments.
 * `readdirSync` returns bare names, but an adversarial symlink or OS quirk
 * could still produce something unexpected.
 *
 * Exported for unit testing.
 */
export function isSafeFilename(fileName: string): boolean {
  if (fileName !== basename(fileName)) return false;
  if (fileName.includes('/') || fileName.includes('\\')) return false;
  if (fileName === '..' || fileName === '.') return false;
  if (fileName.includes('..')) return false;
  return true;
}

export class SkillRegistry {
  private entries: Map<string, SkillEntry> = new Map();
  private skillsDir: string;
  /**
   * Optional validation: when true, skills whose model_hints.prefer
   * contains a provider-pinned model (e.g. gpt-4.1, claude-sonnet)
   * are rejected with a warning. Default: true.
   */
  private rejectPinnedModels: boolean;

  constructor(skillsDir: string, opts?: { rejectPinnedModels?: boolean }) {
    this.skillsDir = skillsDir;
    this.rejectPinnedModels = opts?.rejectPinnedModels ?? true;
  }

  // ── Path safety ──────────────────────────────────────────────────────────

  private checkPathSafe(absPath: string): boolean {
    try {
      if (lstatSync(absPath).isSymbolicLink()) return false;
      const realPath = realpathSync(absPath);
      const skillsDirReal = realpathSync(this.skillsDir);
      return realPath.startsWith(skillsDirReal + sep);
    } catch {
      return false;
    }
  }

  // ── Manifest loading ─────────────────────────────────────────────────────

  /**
   * Scan the skills directory and build the in-memory manifest.
   * Reads only frontmatter — full body is deferred to getFullDefinition().
   */
  loadManifest(): void {
    if (!existsSync(this.skillsDir)) {
      console.warn(`[SkillRegistry] Skills directory not found: ${this.skillsDir}`);
      return;
    }

    let files: string[];
    try {
      files = readdirSync(this.skillsDir);
    } catch {
      console.warn(`[SkillRegistry] Cannot read skills directory: ${this.skillsDir}`);
      return;
    }

    // Collect candidate skill files: flat files + subdirectory SKILL.md files
    const candidates: Array<{ filePath: string; fileName: string }> = [];

    for (const entry of files) {
      if (!isSafeFilename(entry)) {
        console.warn(`[SkillRegistry] Rejected unsafe filename: ${entry}`);
        continue;
      }

      const entryPath = join(this.skillsDir, entry);

      try {
        const st = statSync(entryPath);

        if (st.isDirectory()) {
          // Check for SKILL.md inside the subdirectory
          const skillMd = join(entryPath, 'SKILL.md');
          if (existsSync(skillMd)) {
            candidates.push({ filePath: skillMd, fileName: `${entry}/SKILL.md` });
          }
          continue;
        }

        // Flat file — must be a supported extension
        const ext = extname(entry).toLowerCase();
        if (ext !== '.md' && ext !== '.yaml' && ext !== '.yml') continue;
        candidates.push({ filePath: entryPath, fileName: entry });
      } catch {
        continue;
      }
    }

    if (candidates.length === 0) {
      console.warn(`[SkillRegistry] No skill files found in: ${this.skillsDir}`);
      return;
    }

    for (const { filePath, fileName } of candidates) {
      if (!this.checkPathSafe(filePath)) {
        console.warn(`[SkillRegistry] Rejected unsafe path (symlink or outside directory): ${fileName}`);
        continue;
      }

      try {
        const { size } = statSync(filePath);
        if (size > MAX_SKILL_FILE_BYTES) {
          console.warn(
            `[SkillRegistry] Skipping oversized skill file (${size} bytes > ${MAX_SKILL_FILE_BYTES}): ${fileName}`
          );
          continue;
        }
      } catch {
        console.warn(`[SkillRegistry] Cannot stat skill file: ${filePath}`);
        continue;
      }

      this.loadEntry(filePath, basename(filePath));
    }
  }

  private loadEntry(filePath: string, fileName: string): void {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      console.warn(`[SkillRegistry] Failed to read skill file: ${filePath}`);
      return;
    }

    const ext = extname(fileName).toLowerCase();
    const result = ext === '.md'
      ? parseSkillFrontmatter(content, filePath)
      : parseSkillYaml(content, filePath);

    if (!result.ok) {
      console.warn(`[SkillRegistry] ${result.error}`);
      return;
    }

    const { frontmatter, body } = result.data;

    // Reject pinned models if configured
    if (this.rejectPinnedModels && frontmatter.model_hints.prefer.length > 0) {
      const pinned = findPinnedModel(frontmatter.model_hints.prefer);
      if (pinned) {
        console.warn(
          `[SkillRegistry] Skill ${frontmatter.id} rejected: model_hints.prefer contains provider-pinned model "${pinned}". ` +
          `Use generic model classes (e.g. "frontier", "local-fast") or set rejectPinnedModels: false.`
        );
        return;
      }
    }

    // Check env_required at load time — warn but still register
    for (const envVar of frontmatter.env_required) {
      if (!process.env[envVar]) {
        console.warn(
          `[SkillRegistry] Skill ${frontmatter.id}: env_required variable "${envVar}" is not set. ` +
          `Skill will be registered but may fail at runtime.`
        );
      }
    }

    this.entries.set(frontmatter.id, {
      manifest: frontmatter,
      filePath,
      _cachedBody: ext === '.md' ? body : null,
    });
  }

  // ── Manifest for orchestrator ────────────────────────────────────────────

  /**
   * Returns a compact manifest string for the orchestrator system prompt.
   * Each skill emits: "id — description [inputs: a, b]"
   * Target: <100 tokens per skill entry.
   */
  getManifestForPrompt(): string {
    if (this.entries.size === 0) return 'No tools configured.';

    const parts = [...this.entries.values()].map((e) => {
      const m = e.manifest;
      const inputNames = m.inputs.length > 0
        ? ` [inputs: ${m.inputs.map((i) => i.name).join(', ')}]`
        : '';
      return `${m.id} — ${m.description}${inputNames}`;
    });

    return `Available tools:\n${parts.join('\n')}`;
  }

  /**
   * Return a compact manifest object for a single skill.
   * Used by the orchestrator to make routing decisions without
   * loading the full body.
   */
  getManifest(skillId: string): SkillFrontmatter | null {
    return this.entries.get(skillId)?.manifest ?? null;
  }

  // ── Full body loading (lazy) ─────────────────────────────────────────────

  /**
   * Return the full file contents for a skill.
   * Called ONLY when an executor needs the definition — not at orchestrator time.
   */
  getFullDefinition(skillId: string): string | null {
    const entry = this.entries.get(skillId);
    if (!entry) return null;

    if (!this.checkPathSafe(entry.filePath)) {
      console.warn(`[SkillRegistry] Rejected unsafe path on read: ${entry.filePath}`);
      return null;
    }

    try {
      return readFileSync(entry.filePath, 'utf-8');
    } catch {
      console.warn(`[SkillRegistry] Failed to read skill file: ${entry.filePath}`);
      return null;
    }
  }

  /**
   * Return just the body portion (prompt text after frontmatter).
   * Cached on first access.
   */
  getBody(skillId: string): string | null {
    const entry = this.entries.get(skillId);
    if (!entry) return null;

    if (entry._cachedBody !== null) return entry._cachedBody;

    const full = this.getFullDefinition(skillId);
    if (!full) return null;

    // Re-parse to extract body
    const result = parseSkillFrontmatter(full, entry.filePath);
    if (!result.ok) return null;

    entry._cachedBody = result.data.body;
    return entry._cachedBody;
  }

  // ── Query methods ────────────────────────────────────────────────────────

  listSkills(): string[] {
    return [...this.entries.keys()];
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  getRequiredConnectors(skillId: string): string[] {
    return this.entries.get(skillId)?.manifest.requires_connectors ?? [];
  }

  /**
   * Check whether a skill is eligible for sub-orchestration.
   * Used by the recursive orchestrator to decide if a skill's executor
   * can spawn child orchestrations.
   */
  allowsSubOrchestration(skillId: string): boolean {
    return this.entries.get(skillId)?.manifest.allow_sub_orchestration ?? false;
  }

  /**
   * Filter skills by OS compatibility.
   * Returns skill IDs that are compatible with the given platform.
   */
  skillsForPlatform(platform: NodeJS.Platform): string[] {
    return [...this.entries.entries()]
      .filter(([, e]) => e.manifest.os === null || e.manifest.os === platform)
      .map(([id]) => id);
  }

  /**
   * Get sandbox permissions for a skill.
   * Returns { allow_fs, allow_net } from the manifest.
   */
  getSandboxPermissions(skillId: string): { allow_fs: boolean; allow_net: boolean } | null {
    const m = this.entries.get(skillId)?.manifest;
    if (!m) return null;
    return { allow_fs: m.allow_fs, allow_net: m.allow_net };
  }
}
