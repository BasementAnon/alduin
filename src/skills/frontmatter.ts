/**
 * Skill frontmatter parser.
 *
 * Ported from OpenClaw's agents/skills/frontmatter.ts with adaptations
 * for Alduin's schema (model_hints, allow_sub_orchestration, env_required).
 *
 * SPDX-License-Identifier: MIT
 * Provenance: openclaw/src/agents/skills/frontmatter.ts (structural patterns)
 */

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// ── Zod schemas ──────────────────────────────────────────────────────────────

/** A single input slot the skill expects. */
const SkillInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().max(300).optional(),
  required: z.boolean().default(true),
  type: z.enum(['string', 'number', 'boolean', 'json', 'file']).default('string'),
});

/** Model routing hints for the orchestrator. */
const ModelHintsSchema = z.object({
  /** Preferred model IDs (checked in order). */
  prefer: z.array(z.string()).default([]),
  /** Whether a local/small model fallback is acceptable. */
  fallback_local: z.boolean().default(false),
});

/**
 * Full skill frontmatter schema.
 *
 * Fields:
 *  - id:          kebab-case identifier (unique within the registry)
 *  - description: short summary for orchestrator context (≤ 200 chars)
 *  - inputs:      expected input slots
 *  - model_hints: model routing preferences
 *  - env_required: environment variables that must be set at runtime
 *  - os:          restrict to specific OS (null = any)
 *  - allow_sub_orchestration: whether the skill may spawn child orchestrations
 *  - requires_connectors: external connector IDs this skill depends on
 *  - allow_fs:    whether the sandbox grants filesystem access
 *  - allow_net:   whether the sandbox grants network access
 */
export const SkillFrontmatterSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'id must be kebab-case'),
  description: z.string().max(200, 'description must be ≤ 200 characters'),
  inputs: z.array(SkillInputSchema).default([]),
  model_hints: ModelHintsSchema.default({ prefer: [], fallback_local: false }),
  env_required: z.array(z.string()).default([]),
  os: z.enum(['linux', 'darwin', 'win32']).nullable().default(null),
  allow_sub_orchestration: z.boolean().default(false),
  requires_connectors: z.array(z.string()).default([]),
  allow_fs: z.boolean().default(false),
  allow_net: z.boolean().default(false),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
export type SkillInput = z.infer<typeof SkillInputSchema>;
export type ModelHints = z.infer<typeof ModelHintsSchema>;

// ── Validation helpers ───────────────────────────────────────────────────────

/** Known model ID patterns that are pinned to specific providers. */
const PINNED_MODEL_PATTERNS = [
  /^gpt-/i,        // OpenAI
  /^o[1-9]-/i,     // OpenAI o-series
  /^claude-/i,     // Anthropic
  /^gemini-/i,     // Google
];

/**
 * Check if a model_hints.prefer list contains a "pinned" model that locks the
 * skill to a single provider. Returns the first pinned model found, or null.
 */
export function findPinnedModel(prefer: string[]): string | null {
  for (const model of prefer) {
    if (PINNED_MODEL_PATTERNS.some((pat) => pat.test(model))) {
      return model;
    }
  }
  return null;
}

// ── Parse result ─────────────────────────────────────────────────────────────

export interface ParsedSkillFile {
  frontmatter: SkillFrontmatter;
  /** The body content after the frontmatter (prompt text, code, etc.) */
  body: string;
}

export interface ParseError {
  ok: false;
  error: string;
}

export type ParseResult = { ok: true; data: ParsedSkillFile } | ParseError;

// ── Parser ───────────────────────────────────────────────────────────────────

/**
 * Extract YAML frontmatter from a markdown string.
 * Returns the raw YAML string and the remaining body, or null if no
 * frontmatter block is found.
 */
export function extractFrontmatter(
  content: string
): { yaml: string; body: string } | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) return null;

  // Find the closing --- (skip the opening one)
  const end = trimmed.indexOf('---', 3);
  if (end === -1) return null;

  const yaml = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 3).replace(/^\r?\n/, '');
  return { yaml, body };
}

/**
 * Parse and validate a skill file's YAML frontmatter.
 *
 * @param content   Full file content (markdown with YAML frontmatter)
 * @param filePath  Used only for error messages
 * @returns ParseResult — either { ok: true, data } or { ok: false, error }
 */
export function parseSkillFrontmatter(
  content: string,
  filePath = '<unknown>'
): ParseResult {
  const extracted = extractFrontmatter(content);
  if (!extracted) {
    return { ok: false, error: `${filePath}: no YAML frontmatter found` };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(extracted.yaml);
  } catch (e) {
    return {
      ok: false,
      error: `${filePath}: invalid YAML: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: `${filePath}: frontmatter must be a YAML object` };
  }

  const result = SkillFrontmatterSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `${filePath}: validation failed: ${issues}` };
  }

  return {
    ok: true,
    data: {
      frontmatter: result.data,
      body: extracted.body,
    },
  };
}

/**
 * Parse a YAML-only skill file (no frontmatter delimiters).
 * Used for .yaml/.yml files where the entire file is the manifest.
 */
export function parseSkillYaml(
  content: string,
  filePath = '<unknown>'
): ParseResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (e) {
    return {
      ok: false,
      error: `${filePath}: invalid YAML: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: `${filePath}: YAML must be an object` };
  }

  const result = SkillFrontmatterSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `${filePath}: validation failed: ${issues}` };
  }

  return {
    ok: true,
    data: {
      frontmatter: result.data,
      body: '',
    },
  };
}
