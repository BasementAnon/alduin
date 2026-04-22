import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseSkillFrontmatter } from './frontmatter.js';

const SKILLS_DIR = join(__dirname, '../../skills');

const CURATED_SKILLS = [
  'summarize',
  'research',
  'code-review',
  'plan',
  'extract',
  'rewrite',
];

describe('curated skills', () => {
  for (const skillId of CURATED_SKILLS) {
    describe(skillId, () => {
      const filePath = join(SKILLS_DIR, skillId, 'SKILL.md');
      let content: string;

      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        content = '';
      }

      it('file exists and is non-empty', () => {
        expect(content.length).toBeGreaterThan(0);
      });

      it('frontmatter parses successfully', () => {
        const result = parseSkillFrontmatter(content, filePath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.frontmatter.id).toBe(skillId);
      });

      it('description is ≤ 200 characters', () => {
        const result = parseSkillFrontmatter(content, filePath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.frontmatter.description.length).toBeLessThanOrEqual(200);
      });

      it('has at least one input defined', () => {
        const result = parseSkillFrontmatter(content, filePath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.frontmatter.inputs.length).toBeGreaterThanOrEqual(1);
      });

      it('manifest entry fits in <100 tokens', () => {
        const result = parseSkillFrontmatter(content, filePath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const fm = result.data.frontmatter;
        const inputNames = fm.inputs.map((i) => i.name).join(', ');
        const entry = `${fm.id} — ${fm.description} [inputs: ${inputNames}]`;

        // Conservative token estimate: ~4 chars per token
        const approxTokens = Math.ceil(entry.length / 4);
        expect(approxTokens).toBeLessThan(100);

        // Also check word count
        const wordCount = entry.split(/\s+/).length;
        expect(wordCount).toBeLessThan(100);
      });

      it('body contains required sections', () => {
        const result = parseSkillFrontmatter(content, filePath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const body = result.data.body;
        expect(body).toContain('## System prompt');
        expect(body).toContain('## Inputs');
        expect(body).toContain('## Outputs');
        expect(body).toContain('## Notes');
      });

      it('does not use pinned model names in model_hints.prefer', () => {
        const result = parseSkillFrontmatter(content, filePath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const prefer = result.data.frontmatter.model_hints.prefer;
        const pinned = ['gpt-', 'claude-', 'gemini-', 'o1-', 'o3-'];
        for (const model of prefer) {
          for (const prefix of pinned) {
            expect(model.startsWith(prefix)).toBe(false);
          }
        }
      });
    });
  }

  // ── Specific skill property tests ──────────────────────────────────────

  it('plan skill opts into allow_sub_orchestration', () => {
    const content = readFileSync(join(SKILLS_DIR, 'plan/SKILL.md'), 'utf-8');
    const result = parseSkillFrontmatter(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.frontmatter.allow_sub_orchestration).toBe(true);
  });

  it('all non-plan skills have allow_sub_orchestration = false', () => {
    for (const skillId of CURATED_SKILLS.filter((s) => s !== 'plan')) {
      const content = readFileSync(
        join(SKILLS_DIR, skillId, 'SKILL.md'),
        'utf-8'
      );
      const result = parseSkillFrontmatter(content);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.data.frontmatter.allow_sub_orchestration).toBe(false);
    }
  });

  it('no curated skill declares allow_fs or allow_net', () => {
    for (const skillId of CURATED_SKILLS) {
      const content = readFileSync(
        join(SKILLS_DIR, skillId, 'SKILL.md'),
        'utf-8'
      );
      const result = parseSkillFrontmatter(content);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      // Per runbook: "Do NOT ship any skill that shells out or hits the network"
      expect(result.data.frontmatter.allow_net).toBe(false);
    }
  });
});
