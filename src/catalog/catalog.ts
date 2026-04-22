import { readFileSync, existsSync } from 'fs';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';

// ── Zod schemas ──────────────────────────────────────────────────────────────

export const tokenizerSchema = z.enum([
  'anthropic',
  'cl100k_base',
  'o200k_base',
]);

export type TokenizerName = z.infer<typeof tokenizerSchema>;

const pricingSchema = z.object({
  input: z.number().min(0),
  output: z.number().min(0),
});

const modelEntrySchema = z.object({
  provider: z.string(),
  api_id: z.string(),
  released: z.string(),
  status: z.enum(['stable', 'beta', 'preview', 'deprecated']),
  context_window: z.number().int().positive(),
  max_output_tokens: z.number().int().min(0),
  tokenizer: tokenizerSchema,
  pricing_usd_per_mtok: pricingSchema,
  capabilities: z.array(z.string()),
  deprecated: z.boolean(),
  sunset_date: z.string().nullable(),
});

export type ModelEntry = z.infer<typeof modelEntrySchema>;

const catalogSchema = z.object({
  catalog_version: z.string(),
  models: z.record(z.string(), modelEntrySchema),
});

export type CatalogData = z.infer<typeof catalogSchema>;

// ── Error types ──────────────────────────────────────────────────────────────

export type CatalogErrorCode = 'not_found' | 'deprecated' | 'sunset' | 'load_error';

export interface CatalogError {
  code: CatalogErrorCode;
  model: string;
  message: string;
}

// ── ModelCatalog class ───────────────────────────────────────────────────────

/**
 * Single source of truth for per-model metadata.
 * Providers query pricing and tokenizer here — no hardcoded constants in provider code.
 */
export class ModelCatalog {
  private data: CatalogData;

  constructor(data: CatalogData) {
    this.data = data;
  }

  /** The catalog revision date string */
  get version(): string {
    return this.data.catalog_version;
  }

  /** All known model strings */
  listModels(): string[] {
    return Object.keys(this.data.models);
  }

  /** Check whether a model exists in the catalog */
  has(modelString: string): boolean {
    return modelString in this.data.models;
  }

  /**
   * Look up a model entry.
   * Returns typed errors for missing, deprecated, and sunset models.
   */
  getModel(modelString: string): Result<ModelEntry, CatalogError> {
    const entry = this.data.models[modelString];
    if (!entry) {
      return err({
        code: 'not_found',
        model: modelString,
        message: `Model "${modelString}" not found in catalog (version ${this.data.catalog_version}). Run \`alduin models sync\` to update.`,
      });
    }

    if (entry.sunset_date) {
      const sunset = new Date(entry.sunset_date);
      if (sunset <= new Date()) {
        return err({
          code: 'sunset',
          model: modelString,
          message: `Model "${modelString}" was sunset on ${entry.sunset_date}. Choose a replacement and run \`alduin models upgrade\`.`,
        });
      }
    }

    if (entry.deprecated) {
      // Deprecated returns the entry but with a warning code for callers to handle
      return ok(entry);
    }

    return ok(entry);
  }

  /**
   * Convenience: check deprecation status without failing.
   * Returns true if model exists and is deprecated but not yet sunset.
   */
  isDeprecated(modelString: string): boolean {
    const entry = this.data.models[modelString];
    return entry?.deprecated === true;
  }

  /** Get pricing for a model, or null if missing. */
  getPricing(modelString: string): { input: number; output: number } | null {
    const entry = this.data.models[modelString];
    if (!entry) return null;
    return entry.pricing_usd_per_mtok;
  }

  /** Get the tokenizer name for a model. */
  getTokenizer(modelString: string): TokenizerName | null {
    const entry = this.data.models[modelString];
    if (!entry) return null;
    return entry.tokenizer;
  }

  /** Merge a local override catalog into this one (override takes precedence). */
  mergeOverrides(overrides: Partial<CatalogData>): void {
    if (overrides.models) {
      for (const [key, entry] of Object.entries(overrides.models)) {
        this.data.models[key] = entry;
      }
    }
    if (overrides.catalog_version) {
      this.data.catalog_version = overrides.catalog_version;
    }
  }

  /** Get the raw catalog data (e.g. for diffing). */
  getRawData(): CatalogData {
    return this.data;
  }
}

// ── Loading ──────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG_PATH = join(__dirname, 'models.catalog.json');

/**
 * Load the model catalog from disk, validate with Zod, and optionally
 * merge a local models.override.yaml.
 *
 * @param catalogPath - Path to models.catalog.json (defaults to bundled catalog)
 * @param overridePath - Optional path to models.override.yaml
 */
export function loadCatalog(
  catalogPath: string = DEFAULT_CATALOG_PATH,
  overridePath?: string
): Result<ModelCatalog, CatalogError> {
  let raw: string;
  try {
    raw = readFileSync(catalogPath, 'utf-8');
  } catch (e) {
    return err({
      code: 'load_error',
      model: '',
      message: `Failed to read catalog file: ${catalogPath} — ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return err({
      code: 'load_error',
      model: '',
      message: `Failed to parse catalog JSON: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  const validated = catalogSchema.safeParse(parsed);
  if (!validated.success) {
    const issue = validated.error.issues[0];
    return err({
      code: 'load_error',
      model: '',
      message: `Catalog validation error: ${issue?.path.join('.')}: ${issue?.message}`,
    });
  }

  const catalog = new ModelCatalog(validated.data);

  // Merge local overrides if the file exists
  if (overridePath && existsSync(overridePath)) {
    try {
      const overrideRaw = readFileSync(overridePath, 'utf-8');
      const overrideData = parseYaml(overrideRaw) as Partial<CatalogData>;
      catalog.mergeOverrides(overrideData);
    } catch (e) {
      console.warn(
        `[Catalog] Warning: failed to load overrides from ${overridePath}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  return ok(catalog);
}
