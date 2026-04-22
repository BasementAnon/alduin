import { describe, it, expect } from 'vitest';
import {
  parseSkillFrontmatter,
  parseSkillYaml,
  extractFrontmatter,
  findPinnedModel,
} from './frontmatter.js';

// ── extractFrontmatter ───────────────────────────────────────────────────────

describe('extractFrontmatter', () => {
  it('extracts YAML and body from a markdown file', () => {
    const content = `---
id: summarize
description: Summarize a document
---

## System prompt
You are a summarizer.
`;
    const result = extractFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.yaml).toContain('id: summarize');
    expect(result!.body).toContain('## System prompt');
  });

  it('returns null when no frontmatter present', () => {
    expect(extractFrontmatter('# Just a heading\n\nNo frontmatter.')).toBeNull();
  });

  it('returns null when no closing --- is found', () => {
    expect(extractFrontmatter('---\nid: broken\n')).toBeNull();
  });

  it('handles leading whitespace before frontmatter', () => {
    const content = `  \n---\nid: test\ndescription: test skill\n---\nBody`;
    const result = extractFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.yaml).toContain('id: test');
  });
});

// ── parseSkillFrontmatter ────────────────────────────────────────────────────

describe('parseSkillFrontmatter', () => {
  const validSkill = `---
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
    - local-fast
  fallback_local: true
env_required: []
os: null
allow_sub_orchestration: false
---

## System prompt
You are a summarization expert.
`;

  it('parses a valid skill with all fields', () => {
    const result = parseSkillFrontmatter(validSkill);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fm = result.data.frontmatter;
    expect(fm.id).toBe('summarize');
    expect(fm.description).toBe('Summarize a document concisely');
    expect(fm.inputs).toHaveLength(2);
    expect(fm.inputs[0]!.name).toBe('document');
    expect(fm.inputs[0]!.type).toBe('string');
    expect(fm.inputs[1]!.required).toBe(false);
    expect(fm.model_hints.prefer).toEqual(['frontier', 'local-fast']);
    expect(fm.model_hints.fallback_local).toBe(true);
    expect(fm.allow_sub_orchestration).toBe(false);
    expect(result.data.body).toContain('## System prompt');
  });

  it('applies defaults for optional fields', () => {
    const minimal = `---
id: minimal-skill
description: A minimal skill
---
Body content.
`;
    const result = parseSkillFrontmatter(minimal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fm = result.data.frontmatter;
    expect(fm.inputs).toEqual([]);
    expect(fm.model_hints.prefer).toEqual([]);
    expect(fm.model_hints.fallback_local).toBe(false);
    expect(fm.env_required).toEqual([]);
    expect(fm.os).toBeNull();
    expect(fm.allow_sub_orchestration).toBe(false);
    expect(fm.allow_fs).toBe(false);
    expect(fm.allow_net).toBe(false);
  });

  it('parses a skill with allow_sub_orchestration enabled', () => {
    const content = `---
id: research
description: Deep research with sub-tasks
allow_sub_orchestration: true
model_hints:
  prefer:
    - frontier
  fallback_local: false
---
Research body.
`;
    const result = parseSkillFrontmatter(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.frontmatter.allow_sub_orchestration).toBe(true);
  });

  it('parses a skill with OS restriction', () => {
    const content = `---
id: macos-util
description: macOS-only utility
os: darwin
---
Body.
`;
    const result = parseSkillFrontmatter(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.frontmatter.os).toBe('darwin');
  });

  it('parses a skill with sandbox permissions', () => {
    const content = `---
id: file-processor
description: Processes files on disk
allow_fs: true
allow_net: false
---
Body.
`;
    const result = parseSkillFrontmatter(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.frontmatter.allow_fs).toBe(true);
    expect(result.data.frontmatter.allow_net).toBe(false);
  });

  // ── Rejection tests ──────────────────────────────────────────────────────

  it('rejects missing id', () => {
    const content = `---
description: No id field
---
Body.
`;
    const result = parseSkillFrontmatter(content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('id');
  });

  it('rejects non-kebab-case id', () => {
    const content = `---
id: Bad_Name
description: Invalid id
---
Body.
`;
    const result = parseSkillFrontmatter(content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('kebab-case');
  });

  it('rejects description longer than 200 chars', () => {
    const longDesc = 'a'.repeat(201);
    const content = `---
id: long-desc
description: "${longDesc}"
---
Body.
`;
    const result = parseSkillFrontmatter(content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('200');
  });

  it('rejects invalid os value', () => {
    const content = `---
id: bad-os
description: Bad OS
os: windows
---
Body.
`;
    const result = parseSkillFrontmatter(content);
    expect(result.ok).toBe(false);
  });

  it('rejects invalid YAML', () => {
    const content = `---
: this is: not: valid: [\n
---
Body.
`;
    const result = parseSkillFrontmatter(content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('invalid YAML');
  });

  it('rejects file with no frontmatter', () => {
    const result = parseSkillFrontmatter('# Just markdown');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('no YAML frontmatter');
  });
});

// ── parseSkillYaml ───────────────────────────────────────────────────────────

describe('parseSkillYaml', () => {
  it('parses a valid YAML skill file', () => {
    const content = `id: code-review
description: Review code for bugs and style
inputs:
  - name: code
    type: string
`;
    const result = parseSkillYaml(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.frontmatter.id).toBe('code-review');
    expect(result.data.body).toBe('');
  });

  it('rejects invalid YAML', () => {
    const result = parseSkillYaml(': broken: yaml: [\n');
    expect(result.ok).toBe(false);
  });
});

// ── findPinnedModel ──────────────────────────────────────────────────────────

describe('findPinnedModel', () => {
  it('detects OpenAI models', () => {
    expect(findPinnedModel(['gpt-4.1'])).toBe('gpt-4.1');
    expect(findPinnedModel(['o1-mini'])).toBe('o1-mini');
  });

  it('detects Anthropic models', () => {
    expect(findPinnedModel(['claude-sonnet-4-6'])).toBe('claude-sonnet-4-6');
  });

  it('detects Google models', () => {
    expect(findPinnedModel(['gemini-pro'])).toBe('gemini-pro');
  });

  it('returns null for generic model classes', () => {
    expect(findPinnedModel(['frontier', 'local-fast'])).toBeNull();
    expect(findPinnedModel(['ollama/qwen2.5'])).toBeNull();
  });

  it('returns the first pinned model in order', () => {
    expect(findPinnedModel(['frontier', 'gpt-4.1', 'claude-sonnet-4-6'])).toBe('gpt-4.1');
  });

  it('returns null for empty array', () => {
    expect(findPinnedModel([])).toBeNull();
  });
});
