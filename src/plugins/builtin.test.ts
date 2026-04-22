import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { alduinPluginManifestSchema } from '@alduin/plugin-sdk';

/**
 * Tests that each builtin provider plugin has a valid manifest, schema.json,
 * and models.json -- verifying the plugin structure is correct before the
 * loader ever touches them.
 */

const BUILTIN_DIR = join(__dirname, '..', '..', 'plugins', 'builtin');

const EXPECTED_BUILTINS = ['anthropic', 'openai', 'openai-compatible', 'ollama'];

describe('Builtin provider plugins', () => {
  for (const pluginId of EXPECTED_BUILTINS) {
    describe(pluginId, () => {
      const pluginDir = join(BUILTIN_DIR, pluginId);

      it('has a valid alduin.plugin.json', () => {
        const manifestPath = join(pluginDir, 'alduin.plugin.json');
        expect(existsSync(manifestPath)).toBe(true);

        const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const result = alduinPluginManifestSchema.safeParse(raw);

        if (!result.success) {
          const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
          throw new Error(`Manifest validation failed: ${issues}`);
        }

        expect(result.data.id).toBe(pluginId);
        expect(result.data.kind).toBe('provider');
      });

      it('has a schema.json', () => {
        const schemaPath = join(pluginDir, 'schema.json');
        expect(existsSync(schemaPath)).toBe(true);

        const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
        expect(schema).toHaveProperty('$schema');
        expect(schema).toHaveProperty('type', 'object');
        expect(schema).toHaveProperty('properties');
      });

      it('has a models.json with valid catalog entries', () => {
        const modelsPath = join(pluginDir, 'models.json');
        expect(existsSync(modelsPath)).toBe(true);

        const models = JSON.parse(readFileSync(modelsPath, 'utf-8')) as Record<string, unknown>;
        expect(Object.keys(models).length).toBeGreaterThan(0);

        // Each entry must have the required catalog fields
        for (const [modelId, entry] of Object.entries(models)) {
          const e = entry as Record<string, unknown>;
          expect(e).toHaveProperty('provider');
          expect(e).toHaveProperty('api_id');
          expect(e).toHaveProperty('status');
          expect(e).toHaveProperty('context_window');
          expect(e).toHaveProperty('pricing_usd_per_mtok');
          expect(e).toHaveProperty('tokenizer');

          // Model ID should be "provider/model-name" format
          expect(modelId).toContain('/');
        }
      });

      it('has an entry module (either compiled .js or .ts source)', () => {
        const manifestPath = join(pluginDir, 'alduin.plugin.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

        // Manifest declares the production path (./dist/index.js). Pre-build
        // the compiled artefact won't exist but the .ts source will — the
        // loader's resolveEntryPath() falls back between them. Accept either.
        const declared = join(pluginDir, manifest.entry);
        const tsFallback = declared.replace(/\.js$/, '.ts').replace('/dist/', '/src/');
        expect(existsSync(declared) || existsSync(tsFallback)).toBe(true);
      });

      it('declares provider IDs in the manifest', () => {
        const manifestPath = join(pluginDir, 'alduin.plugin.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        expect(manifest.providers).toBeDefined();
        expect(manifest.providers.length).toBeGreaterThan(0);
      });
    });
  }

  it('all four builtins are present', () => {
    for (const id of EXPECTED_BUILTINS) {
      expect(existsSync(join(BUILTIN_DIR, id, 'alduin.plugin.json'))).toBe(true);
    }
  });

  it('no duplicate provider IDs across builtins', () => {
    const allProviderIds: string[] = [];
    for (const id of EXPECTED_BUILTINS) {
      const manifest = JSON.parse(
        readFileSync(join(BUILTIN_DIR, id, 'alduin.plugin.json'), 'utf-8'),
      );
      allProviderIds.push(...manifest.providers);
    }
    const unique = new Set(allProviderIds);
    expect(unique.size).toBe(allProviderIds.length);
  });
});
