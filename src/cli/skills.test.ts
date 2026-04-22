import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { SkillRegistry } from '../skills/registry.js';
import { addSkill } from './skills.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'alduin-cli-skills-'));
}

// ── Registry scanning subdirectories ─────────────────────────────────────────

describe('SkillRegistry with subdirectory layout', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads skills from <name>/SKILL.md subdirectory layout', () => {
    mkdirSync(join(tmpDir, 'summarize'));
    writeFileSync(
      join(tmpDir, 'summarize', 'SKILL.md'),
      `---
id: summarize
description: Summarize a document
---
## System prompt
Summarize.
`
    );

    mkdirSync(join(tmpDir, 'research'));
    writeFileSync(
      join(tmpDir, 'research', 'SKILL.md'),
      `---
id: research
description: Research a topic
---
## System prompt
Research.
`
    );

    const registry = new SkillRegistry(tmpDir);
    registry.loadManifest();

    expect(registry.has('summarize')).toBe(true);
    expect(registry.has('research')).toBe(true);
    expect(registry.listSkills()).toHaveLength(2);
  });

  it('loads mixed flat files and subdirectories', () => {
    // Flat file
    writeFileSync(
      join(tmpDir, 'flat-skill.md'),
      `---
id: flat-skill
description: A flat file skill
---
Body.
`
    );

    // Subdirectory
    mkdirSync(join(tmpDir, 'sub-skill'));
    writeFileSync(
      join(tmpDir, 'sub-skill', 'SKILL.md'),
      `---
id: sub-skill
description: A subdirectory skill
---
Body.
`
    );

    const registry = new SkillRegistry(tmpDir);
    registry.loadManifest();

    expect(registry.has('flat-skill')).toBe(true);
    expect(registry.has('sub-skill')).toBe(true);
    expect(registry.listSkills()).toHaveLength(2);
  });

  it('ignores subdirectories without SKILL.md', () => {
    mkdirSync(join(tmpDir, 'empty-dir'));
    mkdirSync(join(tmpDir, 'has-skill'));
    writeFileSync(
      join(tmpDir, 'has-skill', 'SKILL.md'),
      `---
id: has-skill
description: Has a skill file
---
Body.
`
    );

    const registry = new SkillRegistry(tmpDir);
    registry.loadManifest();

    expect(registry.listSkills()).toHaveLength(1);
    expect(registry.has('has-skill')).toBe(true);
  });
});

// ── Curated skills bundle integration ────────────────────────────────────────

describe('curated skills bundle via registry', () => {
  const curatedDir = join(__dirname, '../../skills');

  it('loads all 6 curated skills', () => {
    const registry = new SkillRegistry(curatedDir, { rejectPinnedModels: true });
    registry.loadManifest();

    const skills = registry.listSkills().sort();
    expect(skills).toEqual([
      'code-review',
      'extract',
      'plan',
      'research',
      'rewrite',
      'summarize',
    ]);
  });

  it('manifest for prompt includes all 6 skills', () => {
    const registry = new SkillRegistry(curatedDir, { rejectPinnedModels: true });
    registry.loadManifest();

    const manifest = registry.getManifestForPrompt();
    expect(manifest).toContain('summarize');
    expect(manifest).toContain('research');
    expect(manifest).toContain('code-review');
    expect(manifest).toContain('plan');
    expect(manifest).toContain('extract');
    expect(manifest).toContain('rewrite');
  });

  it('show for each skill returns non-null body', () => {
    const registry = new SkillRegistry(curatedDir, { rejectPinnedModels: true });
    registry.loadManifest();

    for (const id of registry.listSkills()) {
      const body = registry.getBody(id);
      expect(body).not.toBeNull();
      expect(body!.length).toBeGreaterThan(0);
    }
  });

  it('plan skill has allow_sub_orchestration enabled', () => {
    const registry = new SkillRegistry(curatedDir, { rejectPinnedModels: true });
    registry.loadManifest();

    expect(registry.allowsSubOrchestration('plan')).toBe(true);
    expect(registry.allowsSubOrchestration('summarize')).toBe(false);
  });
});

// ── User/curated shadowing ───────────────────────────────────────────────────

describe('user/curated skill shadowing', () => {
  let userDir: string;
  let curatedDir: string;

  beforeEach(() => {
    curatedDir = makeTmpDir();
    userDir = makeTmpDir();

    // Create a curated skill
    mkdirSync(join(curatedDir, 'my-skill'));
    writeFileSync(
      join(curatedDir, 'my-skill', 'SKILL.md'),
      `---
id: my-skill
description: Curated version
---
Curated body.
`
    );

    // Create a user skill with the same id
    mkdirSync(join(userDir, 'my-skill'));
    writeFileSync(
      join(userDir, 'my-skill', 'SKILL.md'),
      `---
id: my-skill
description: User version overrides curated
---
User body.
`
    );
  });

  afterEach(() => {
    rmSync(curatedDir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  it('detects shadowed skills', () => {
    const curated = new SkillRegistry(curatedDir);
    curated.loadManifest();

    const user = new SkillRegistry(userDir);
    user.loadManifest();

    expect(curated.has('my-skill')).toBe(true);
    expect(user.has('my-skill')).toBe(true);

    // User version takes priority in merged view
    const userManifest = user.getManifest('my-skill');
    expect(userManifest!.description).toBe('User version overrides curated');
  });
});

// ── addSkill (CLI install) ───────────────────────────────────────────────────

const SAMPLE_SKILL_MD = `---
id: cli-add-test-skill
description: Minimal skill used by addSkill() regression tests
inputs:
  - name: text
    type: string
    required: true
    description: The input text
model_hints:
  prefer: []
  fallback_local: true
env_required: []
os: null
allow_sub_orchestration: false
allow_fs: false
allow_net: false
---

## System prompt

Test skill body.
`;

describe('addSkill — install from file path or directory', () => {
  let src: string;
  const installedDir = join(homedir(), '.alduin', 'skills', 'cli-add-test-skill');

  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), 'alduin-add-skill-src-'));
    if (existsSync(installedDir)) {
      rmSync(installedDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (existsSync(src)) rmSync(src, { recursive: true, force: true });
    if (existsSync(installedDir)) {
      rmSync(installedDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('installs a skill from a single .md file path (regression: readdirSync on file)', () => {
    const filePath = join(src, 'mySkill.md');
    writeFileSync(filePath, SAMPLE_SKILL_MD, 'utf-8');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    expect(() => addSkill(filePath)).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();

    expect(existsSync(join(installedDir, 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(installedDir, 'SKILL.md'), 'utf-8')).toContain(
      'id: cli-add-test-skill'
    );
  });

  it('installs a skill from a directory containing SKILL.md (and copies siblings)', () => {
    const skillSrcDir = join(src, 'my-skill-dir');
    mkdirSync(skillSrcDir, { recursive: true });
    writeFileSync(join(skillSrcDir, 'SKILL.md'), SAMPLE_SKILL_MD, 'utf-8');
    writeFileSync(join(skillSrcDir, 'helper.txt'), 'asset', 'utf-8');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    expect(() => addSkill(skillSrcDir)).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();

    expect(existsSync(join(installedDir, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(installedDir, 'helper.txt'))).toBe(true);
  });
});
