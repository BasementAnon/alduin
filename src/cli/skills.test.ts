import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SkillRegistry } from '../skills/registry.js';

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
