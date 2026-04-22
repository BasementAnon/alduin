#!/usr/bin/env tsx
/**
 * scripts/generate-schema.ts
 *
 * Generates src/config/schema.generated.ts from the live Zod schema and
 * hint table.
 *
 * Usage:
 *   npm run config:generate          # write the file
 *   npm run config:check             # exit non-zero if file is out of date
 *
 * How it works:
 *   1. Converts alduinConfigSchema → JSON Schema (Draft-07) via zod-to-json-schema.
 *   2. Walks the JSON Schema tree and enriches nodes with title/description
 *      from SCHEMA_HINTS.
 *   3. Merges any plugin-contributed schemas from plugins/builtin/ manifests
 *      (empty array for now; shape is reserved for Phase 2).
 *   4. Computes a SHA-256 of the schema source files so drift can be detected
 *      without regenerating the full tree.
 *   5. Writes src/config/schema.generated.ts as a TypeScript const file.
 *
 * --check mode:
 *   Re-generates the content in memory, normalises away the timestamp comment,
 *   and diffs against the committed file. Exits 1 on drift, 0 when up to date.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { alduinConfigSchema } from '../src/config/schema/index.js';
import { SCHEMA_HINTS, isSensitivePath } from '../src/config/schema-hints.js';

// ── Paths ─────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const OUTPUT = join(ROOT, 'src', 'config', 'schema.generated.ts');

/** Source files whose content contributes to the INPUT_SHA. */
const SCHEMA_SOURCES = [
  'src/config/schema/secrets.ts',
  'src/config/schema/models.ts',
  'src/config/schema/providers.ts',
  'src/config/schema/channels.ts',
  'src/config/schema/agents.ts',
  'src/config/schema/auth.ts',
  'src/config/schema/index.ts',
  'src/config/schema-hints.ts',
];

// ── Plugin manifest collection (Phase 2 placeholder) ─────────────────────────

interface PluginManifest {
  id: string;
  contributes?: { config_schema?: string };
}

function collectPluginSchemas(): Record<string, unknown>[] {
  const pluginsDir = join(ROOT, 'plugins', 'builtin');
  if (!existsSync(pluginsDir)) return [];

  const schemas: Record<string, unknown>[] = [];

  let entries: string[];
  try {
    entries = readdirSync(pluginsDir);
  } catch {
    return schemas;
  }

  for (const entry of entries) {
    const pluginDir = join(pluginsDir, entry);
    try {
      if (!statSync(pluginDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const manifestPath = join(pluginDir, 'alduin.plugin.json');
    if (!existsSync(manifestPath)) continue;

    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest;
      if (manifest.contributes?.config_schema) {
        const schemaPath = join(pluginDir, manifest.contributes.config_schema);
        if (existsSync(schemaPath)) {
          const schema = JSON.parse(readFileSync(schemaPath, 'utf-8')) as Record<string, unknown>;
          schemas.push(schema);
        }
      }
    } catch {
      console.warn(`Warning: Failed to parse plugin manifest at ${manifestPath}`);
    }
  }

  return schemas;
}

// ── SHA of inputs ─────────────────────────────────────────────────────────────

function computeInputSha(pluginSchemas: Record<string, unknown>[]): string {
  const hash = createHash('sha256');
  for (const rel of SCHEMA_SOURCES) {
    const abs = join(ROOT, rel);
    if (existsSync(abs)) {
      hash.update(readFileSync(abs));
    }
  }
  if (pluginSchemas.length > 0) {
    hash.update(JSON.stringify(pluginSchemas));
  }
  return hash.digest('hex').slice(0, 16);
}

// ── JSON Schema types (minimal, self-contained) ───────────────────────────────

type JsonSchemaNode = {
  title?: string;
  description?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: JsonSchemaNode | boolean;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  enum?: unknown[];
  required?: string[];
  $schema?: string;
  [key: string]: unknown;
};

// ── Hint enrichment ───────────────────────────────────────────────────────────

/**
 * Walk a JSON Schema node tree, enriching each node with title/description
 * from SCHEMA_HINTS (keyed by dotted path).
 *
 * If no explicit hint exists for a path but isSensitivePath() returns true,
 * x-alduin-sensitive is set to true for downstream consumers.
 */
function enrichNode(node: JsonSchemaNode, path: string): void {
  const hint = SCHEMA_HINTS[path];

  if (hint) {
    if (hint.label && !node.title) node.title = hint.label;
    if (hint.help && !node.description) node.description = hint.help;
    if (hint.sensitive === true) node['x-alduin-sensitive'] = true;
    if (hint.advanced === true) node['x-alduin-advanced'] = true;
  } else if (path && isSensitivePath(path)) {
    node['x-alduin-sensitive'] = true;
  }

  // Recurse into object properties
  if (node.properties) {
    for (const [key, child] of Object.entries(node.properties)) {
      const childPath = path ? `${path}.${key}` : key;
      enrichNode(child, childPath);
    }
  }

  // Record additionalProperties → wildcard path
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    const wcPath = path ? `${path}.*` : '*';
    enrichNode(node.additionalProperties as JsonSchemaNode, wcPath);
  }

  // Array items
  if (node.items && typeof node.items === 'object') {
    const itemPath = path ? `${path}[]` : '[]';
    enrichNode(node.items as JsonSchemaNode, itemPath);
  }

  // Combiners — propagate path (union/intersection members share the same path)
  for (const combiner of ['anyOf', 'allOf', 'oneOf'] as const) {
    if (Array.isArray(node[combiner])) {
      for (const branch of node[combiner] as JsonSchemaNode[]) {
        enrichNode(branch, path);
      }
    }
  }
}

// ── Plugin schema merge ───────────────────────────────────────────────────────

function mergePluginSchemas(
  base: JsonSchemaNode,
  plugins: Record<string, unknown>[]
): JsonSchemaNode {
  // Phase 2: deep-merge plugin `properties` fragments into the base schema.
  // For now, just return the base untouched.
  void plugins;
  return base;
}

// ── File content generation ───────────────────────────────────────────────────

const TIMESTAMP_LINE_RE = /^\/\/ Generated at: .+$/m;

/**
 * Produce the full content of schema.generated.ts.
 * `generatedAt` is injected into the file-level comment only; it does not
 * affect the exported consts, so the drift check can ignore that line.
 */
function buildFileContent(
  schema: JsonSchemaNode,
  inputSha: string,
  generatedAt: string
): string {
  const schemaJson = JSON.stringify(schema, null, 2);

  return `\
// Auto-generated by scripts/generate-schema.ts — do not edit directly.
// Run \`npm run config:generate\` to regenerate after modifying schema source files.
//
// Input SHA: ${inputSha}
// Generated at: ${generatedAt}

/* eslint-disable */
// prettier-ignore

/** Minimal JSON Schema node shape used in the generated output. */
export type JsonSchemaNode = {
  title?: string;
  description?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: JsonSchemaNode | boolean;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  enum?: unknown[];
  required?: string[];
  $schema?: string;
  [key: string]: unknown;
};

/** SHA-256 (first 16 hex chars) of the schema source files used as input. */
export const INPUT_SHA = '${inputSha}';

/** JSON Schema (Draft-07) for the complete Alduin YAML configuration. */
export const GENERATED_CONFIG_SCHEMA: JsonSchemaNode = ${schemaJson};
`;
}

// ── Normalise for comparison (strip the volatile timestamp line) ──────────────

function normalise(content: string): string {
  return content.replace(TIMESTAMP_LINE_RE, '// Generated at: <normalised>');
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const checkMode = args.includes('--check');

  // 1. Collect plugin schemas (empty for now)
  const pluginSchemas = collectPluginSchemas();

  // 2. Compute input SHA
  const inputSha = computeInputSha(pluginSchemas);

  // 3. Convert Zod → JSON Schema
  const rawSchema = zodToJsonSchema(alduinConfigSchema, {
    target: 'jsonSchema7',
    $schema: true,
  }) as JsonSchemaNode;

  // 4. Enrich with hints
  enrichNode(rawSchema, '');

  // 5. Merge plugin schemas
  const merged = mergePluginSchemas(rawSchema, pluginSchemas);

  // 6. Build file content
  const generatedAt = new Date().toISOString();
  const content = buildFileContent(merged, inputSha, generatedAt);

  if (checkMode) {
    // ── Check mode ────────────────────────────────────────────────────────────
    if (!existsSync(OUTPUT)) {
      console.error(`\n✗  ${OUTPUT} does not exist.\n   Run: npm run config:generate\n`);
      process.exit(1);
    }

    const committed = readFileSync(OUTPUT, 'utf-8');
    const normCommitted = normalise(committed);
    const normFresh = normalise(content);

    if (normCommitted === normFresh) {
      console.log('✓  Config schema is up to date.');
      process.exit(0);
    }

    console.error('\n✗  Config schema is out of date.\n');
    console.error('   Run:  npm run config:generate');
    console.error('   Then: git add src/config/schema.generated.ts && git commit\n');

    // Show a simple line diff to help identify what changed
    const committedLines = normCommitted.split('\n');
    const freshLines = normFresh.split('\n');
    let shown = 0;
    const MAX_DIFF_LINES = 30;

    for (let i = 0; i < Math.max(committedLines.length, freshLines.length); i++) {
      if (committedLines[i] !== freshLines[i]) {
        if (shown < MAX_DIFF_LINES) {
          console.error(`  line ${i + 1}:`);
          if (committedLines[i] !== undefined) {
            console.error(`  - ${committedLines[i]}`);
          }
          if (freshLines[i] !== undefined) {
            console.error(`  + ${freshLines[i]}`);
          }
        }
        shown++;
      }
    }

    if (shown > MAX_DIFF_LINES) {
      console.error(`  … and ${shown - MAX_DIFF_LINES} more differing lines.`);
    }
    console.error('');
    process.exit(1);
  } else {
    // ── Generate mode ─────────────────────────────────────────────────────────
    writeFileSync(OUTPUT, content, 'utf-8');
    console.log(`✓  Wrote ${OUTPUT}`);
    console.log(`   Input SHA: ${inputSha}`);
    console.log(`   Plugin schemas merged: ${pluginSchemas.length}`);
  }
}

main();
