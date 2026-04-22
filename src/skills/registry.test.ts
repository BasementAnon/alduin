import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SkillRegistry, isSafeFilename } from './registry.js';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Buffer } from 'node:buffer';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'alduin-skills-'));
}

// ── Representative skill files ───────────────────────────────────────────────

const SKILL_SUMMARIZE = `---
id: summarize
description: Summarize a document concisely
inputs:
  - name: document
    type: string
    required: true
  - name: max-length
    type: number
    required: false
model_hints:
  prefer:
    - frontier
  fallback_local: true
allow_sub_orchestration: false
---

## System prompt
You are a summarization expert. Produce a concise summary.
`;

const SKILL_RESEARCH = `---
id: research
description: Deep research with recursive sub-tasks
inputs:
  - name: query
    type: string
model_hints:
  prefer:
    - frontier
  fallback_local: false
allow_sub_orchestration: true
---

## System prompt
You are a research agent.
`;

const SKILL_CODE_REVIEW = `---
id: code-review
description: Review code for bugs and style issues
inputs:
  - name: code
    type: string
  - name: language
    type: string
    required: false
model_hints:
  prefer: []
  fallback_local: true
---

## System prompt
You are a code reviewer.
`;

const SKILL_EXTRACT = `---
id: extract
description: Extract structured data from text
inputs:
  - name: text
    type: string
  - name: schema
    type: json
allow_fs: true
---

## System prompt
You extract data.
`;

const SKILL_REWRITE = `---
id: rewrite
description: Rewrite text in a given style
inputs:
  - name: text
    type: string
  - name: style
    type: string
os: linux
env_required:
  - REWRITE_API_KEY
---

## System prompt
You rewrite text.
`;

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SkillRegistry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 5 representative skill files ─────────────────────────────────────────

  it('loads 5 representative skill files from markdown', () => {
    writeFileSync(join(tmpDir, 'summarize.md'), SKILL_SUMMARIZE);
    writeFileSync(join(tmpDir, 'research.md'), SKILL_RESEARCH);
    writeFileSync(join(tmpDir, 'code-review.md'), SKILL_CODE_REVIEW);
    writeFileSync(join(tmpDir, 'extract.md'), SKILL_EXTRACT);
    writeFileSync(join(tmpDir, 'rewrite.md'), SKILL_REWRITE);

    // Set env var to avoid warning for rewrite skill
    process.env['REWRITE_API_KEY'] = 'test-key';

    const registry = new SkillRegistry(tmpDir, { rejectPinnedModels: true });
    registry.loadManifest();

    expect(registry.listSkills()).toHaveLength(5);
    expect(registry.has('summarize')).toBe(true);
    expect(registry.has('research')).toBe(true);
    expect(registry.has('code-review')).toBe(true);
    expect(registry.has('extract')).toBe(true);
    expect(registry.has('rewrite')).toBe(true);

    delete process.env['REWRITE_API_KEY'];
  });

  // ── Reject bad model pin ─────────────────────────────────────────────────

  it('rejects a skill with a provider-pinned model in model_hints.prefer', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const pinned = `---
id: pinned-skill
description: Uses a pinned model
model_hints:
  prefer:
    - gpt-4.1
  fallback_local: false
---
Body.
`;
    writeFileSync(join(tmpDir, 'pinned.md'), pinned);

    const registry = new SkillRegistry(tmpDir, { rejectPinnedModels: true });
    registry.loadManifest();

    expect(registry.has('pinned-skill')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('provider-pinned model')
    );

    warnSpy.mockRestore();
  });

  it('allows pinned models when rejectPinnedModels is false', () => {
    const pinned = `---
id: pinned-ok
description: Uses a pinned model but it is allowed
model_hints:
  prefer:
    - claude-sonnet-4-6
  fallback_local: false
---
Body.
`;
    writeFileSync(join(tmpDir, 'pinned-ok.md'), pinned);

    const registry = new SkillRegistry(tmpDir, { rejectPinnedModels: false });
    registry.loadManifest();

    expect(registry.has('pinned-ok')).toBe(true);
  });

  // ── Reject env_required unset ────────────────────────────────────────────

  it('warns when env_required variable is not set', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Ensure MISSING_VAR is not set
    delete process.env['MISSING_VAR'];

    const content = `---
id: env-skill
description: Needs an env var
env_required:
  - MISSING_VAR
---
Body.
`;
    writeFileSync(join(tmpDir, 'env-skill.md'), content);

    const registry = new SkillRegistry(tmpDir, { rejectPinnedModels: true });
    registry.loadManifest();

    // Skill is still registered but with a warning
    expect(registry.has('env-skill')).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('MISSING_VAR')
    );

    warnSpy.mockRestore();
  });

  // ── Manifest <100 tokens per skill ───────────────────────────────────────

  it('manifest entry is under 100 tokens per skill', () => {
    writeFileSync(join(tmpDir, 'summarize.md'), SKILL_SUMMARIZE);
    writeFileSync(join(tmpDir, 'research.md'), SKILL_RESEARCH);
    writeFileSync(join(tmpDir, 'code-review.md'), SKILL_CODE_REVIEW);

    const registry = new SkillRegistry(tmpDir, { rejectPinnedModels: true });
    registry.loadManifest();

    const manifest = registry.getManifestForPrompt();

    // Split into per-skill lines (first line is "Available tools:")
    const lines = manifest.split('\n').filter((l) => l.includes(' — '));

    for (const line of lines) {
      // Rough token estimate: ~4 chars per token for English
      const approxTokens = Math.ceil(line.length / 4);
      expect(approxTokens).toBeLessThan(100);

      // Also check word count — tokens roughly match words for English
      const wordCount = line.split(/\s+/).length;
      expect(wordCount).toBeLessThan(100);
    }
  });

  // ── Compact manifest format ──────────────────────────────────────────────

  it('getManifestForPrompt returns compact format with inputs', () => {
    writeFileSync(join(tmpDir, 'summarize.md'), SKILL_SUMMARIZE);

    const registry = new SkillRegistry(tmpDir, { rejectPinnedModels: true });
    registry.loadManifest();

    const manifest = registry.getManifestForPrompt();
    expect(manifest).toContain('Available tools:');
    expect(manifest).toContain('summarize');
    expect(manifest).toContain('[inputs: document, max-length]');
  });

  it('getManifestForPrompt returns "No tools" for empty registry', () => {
    const registry = new SkillRegistry(tmpDir);
    registry.loadManifest();
    expect(registry.getManifestForPrompt()).toBe('No tools configured.');
  });

  // ── getManifest returns individual manifest ──────────────────────────────

  it('getManifest returns frontmatter for a known skill', () => {
    writeFileSync(join(tmpDir, 'summarize.md'), SKILL_SUMMARIZE);

    const registry = new SkillRegistry(tmpDir);
    registry.loadManifest();

    const m = registry.getManifest('summarize');
    expect(m).not.toBeNull();
    expect(m!.id).toBe('summarize');
    expect(m!.model_hints.fallback_local).toBe(true);
  });

  it('getManifest returns null for unknown skill', () => {
    const registry = new SkillRegistry(tmpDir);
    registry.loadManifest();
    expect(registry.getManifest('nonexistent')).toBeNull();
  });

  // ── Full definition / body loading ───────────────────────────────────────

  it('getFullDefinition returns the full file content', () => {
    writeFileSync(join(tmpDir, 'summarize.md'), SKILL_SUMMARIZE);

    const registry = new SkillRegistry(tmpDir);
    registry.loadManifest();

    const full = registry.getFullDefinition('summarize');
    expect(full).toBe(SKILL_SUMMARIZE);
  });

  it('getFullDefinition returns null for unknown skill', () => {
    const registry = new SkillRegistry(tmpDir);
    registry.loadManifest();
    expect(registry.getFullDefinition('nope')).toBeNull();
  });

  it('getBody returns just the body portion', () => {
    writeFileSync(join(tmpDir, 'summarize.md'), SKILL_SUMMARIZE);

    const registry = new SkillRegistry(tmpDir);
    registry.loadManifest();

    const body = registry.getBody('summarize');
    expect(body).toContain('## System prompt');
    expect(body).not.toContain('---');
    expect(body).not.toContain('id: summarize');
  });

  // ── Query methods ────────────────────────────────────────────────────────

  it('allowsSubOrchestration returns correct values', () => {
    writeFileSync(join(tmpDir, 'summarize.md'), SKILL_SUMMARIZE);
    writeFileSync(join(tmpDir, 'research.md'), SKILL_RESEARCH);

    const registry = new SkillRegistry(tmpDir);
    registry.loadManifest();

    expect(registry.allowsSubOrchestration('summarize')).toBe(false);
    expect(registry.allowsSubOrchestration('research')).toBe(true);
    expect(registry.allowsSubOrchestration('nonexistent')).toBe(false);
  });

  it('getSandboxPermissions returns fs/net flags', () => {
    writeFileSync(join(tmpDir, 'extract.md'), SKILL_EXTRACT);

    const registry = new SkillRegistry(tmpDir);
    registry.loadManifest();

    const perms = registry.getSandboxPermissions('extract');
    expect(perms).toEqual({ allow_fs: true, allow_net: false });
  });

  it('skillsForPlatform filters by OS', () => {
    writeFileSync(join(tmpDir, 'summarize.md'), SKILL_SUMMARIZE); // os: null (any)
    writeFileSync(join(tmpDir, 'rewrite.md'), SKILL_REWRITE); // os: linux
    process.env['REWRITE_API_KEY'] = 'test';

    const registry = new SkillRegistry(tmpDir);
    registry.loadManifest();

    const linuxSkills = registry.skillsForPlatform('linux');
    expect(linuxSkills).toContain('summarize');
    expect(linuxSkills).toContain('rewrite');

    const darwinSkills = registry.skillsForPlatform('darwin');
    expect(darwinSkills).toContain('summarize');
    expect(darwinSkills).not.toContain('rewrite');

    delete process.env['REWRITE_API_KEY'];
  });

  it('getRequiredConnectors returns connector list', () => {
    const content = `---
id: slack-post
description: Post a message to Slack
requires_connectors:
  - slack
  - oauth
---
Body.
`;
    writeFileSync(join(tmpDir, 'slack-post.md'), content);

    const registry = new SkillRegistry(tmpDir);
    registry.loadManifest();

    expect(registry.getRequiredConnectors('slack-post')).toEqual(['slack', 'oauth']);
  });

  // ── YAML skill files ────────────────────────────────────────────────────

  it('loads skill from .yaml file', () => {
    writeFileSync(
      join(tmpDir, 'simple.yaml'),
      `id: simple\ndescription: A simple YAML skill\n`
    );

    const registry = new SkillRegistry(tmpDir);
    registry.loadManifest();

    expect(registry.has('simple')).toBe(true);
  });

  // ── Security tests (preserved from previous) ────────────────────────────

  it('isSafeFilename rejects path-traversal patterns', () => {
    expect(isSafeFilename('../evil.yaml')).toBe(false);
    expect(isSafeFilename('../../etc/passwd')).toBe(false);
    expect(isSafeFilename('subdir/skill.yaml')).toBe(false);
    expect(isSafeFilename('..')).toBe(false);
    expect(isSafeFilename('.')).toBe(false);

    expect(isSafeFilename('web-search.md')).toBe(true);
    expect(isSafeFilename('file-ops.yaml')).toBe(true);
  });

  it('skips files larger than 256 KiB', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const bigContent = 'id: big\ndescription: big\n' + 'x: ' + 'a'.repeat(257 * 1024);
    writeFileSync(join(tmpDir, 'big.yaml'), bigContent);

    const registry = new SkillRegistry(tmpDir);
    registry.loadManifest();

    expect(registry.listSkills()).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/oversized/i));

    warnSpy.mockRestore();
  });

  it('accepts a file exactly at the 256 KiB boundary', () => {
    const prefix = 'id: edge-skill\ndescription: Edge skill\n';
    const padding = '#' + 'x'.repeat(256 * 1024 - prefix.length - 1);
    const content = (prefix + padding).slice(0, 256 * 1024);
    writeFileSync(join(tmpDir, 'edge.yaml'), Buffer.from(content));

    const registry = new SkillRegistry(tmpDir);
    registry.loadManifest();

    expect(registry.has('edge-skill')).toBe(true);
  });

  it('rejects symlinks pointing outside the skills directory', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const outsideDir = mkdtempSync(join(tmpdir(), 'alduin-outside-'));
    writeFileSync(join(outsideDir, 'secret.txt'), 'confidential data');

    try {
      symlinkSync(join(outsideDir, 'secret.txt'), join(tmpDir, 'evil.yaml'));

      const registry = new SkillRegistry(tmpDir);
      registry.loadManifest();

      expect(registry.listSkills()).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/unsafe path|symlink/i));
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
      warnSpy.mockRestore();
    }
  });

  it('handles missing skills directory gracefully', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const registry = new SkillRegistry('/nonexistent/skills/path');
    registry.loadManifest();

    expect(registry.listSkills()).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));

    warnSpy.mockRestore();
  });

  it('skips files with invalid YAML without crashing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    writeFileSync(join(tmpDir, 'corrupt.yaml'), ': not: valid: [\n');
    writeFileSync(join(tmpDir, 'good.md'), `---\nid: good\ndescription: Good skill\n---\nBody.\n`);

    const registry = new SkillRegistry(tmpDir);
    registry.loadManifest();

    expect(registry.has('good')).toBe(true);
    expect(registry.listSkills()).toHaveLength(1);

    warnSpy.mockRestore();
  });

  it('rejects non-kebab-case id', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    writeFileSync(join(tmpDir, 'bad.yaml'), 'id: Bad_Name\ndescription: Has underscores\n');

    const registry = new SkillRegistry(tmpDir);
    registry.loadManifest();

    expect(registry.listSkills()).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('handles file deleted between manifest load and getFullDefinition', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const filePath = join(tmpDir, 'race.md');
    writeFileSync(filePath, `---\nid: race\ndescription: Will disappear\n---\nBody.\n`);

    const registry = new SkillRegistry(tmpDir);
    registry.loadManifest();
    expect(registry.has('race')).toBe(true);

    rmSync(filePath);
    const result = registry.getFullDefinition('race');
    expect(result).toBeNull();

    warnSpy.mockRestore();
  });
});
