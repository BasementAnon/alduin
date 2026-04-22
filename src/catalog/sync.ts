import type { AlduinConfig } from '../config/types.js';
import type { CatalogData } from './catalog.js';

/** Result of probing a single provider's /models endpoint */
export interface ProviderProbeResult {
  provider: string;
  models: string[];
  error?: string;
}

/** Diff entry: new, removed, or changed model */
export interface CatalogDiffEntry {
  model: string;
  status: 'new' | 'removed' | 'changed';
  details?: string;
}

/**
 * Probe provider /models endpoints to discover available models.
 * Does NOT modify the catalog or config — just returns what's available.
 */
export async function probeProviders(config: AlduinConfig): Promise<ProviderProbeResult[]> {
  const results: ProviderProbeResult[] = [];

  for (const [name, providerConfig] of Object.entries(config.providers)) {
    try {
      const baseUrl = providerConfig.base_url ?? getDefaultBaseUrl(name);
      const apiKey = providerConfig.api_key_env
        ? process.env[providerConfig.api_key_env] ?? ''
        : '';

      const models = await fetchModels(name, baseUrl, apiKey);
      results.push({ provider: name, models });
    } catch (e) {
      results.push({
        provider: name,
        models: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return results;
}

/**
 * Compute a diff between the current catalog and discovered models.
 */
export function computeDiff(
  catalog: CatalogData,
  probeResults: ProviderProbeResult[]
): CatalogDiffEntry[] {
  const diffs: CatalogDiffEntry[] = [];
  const catalogModels = new Set(Object.keys(catalog.models));

  for (const probe of probeResults) {
    for (const modelId of probe.models) {
      const qualifiedName = `${probe.provider}/${modelId}`;
      if (!catalogModels.has(qualifiedName)) {
        diffs.push({
          model: qualifiedName,
          status: 'new',
          details: `Discovered via ${probe.provider} /models endpoint`,
        });
      }
    }
  }

  const discoveredSet = new Set<string>();
  for (const probe of probeResults) {
    for (const modelId of probe.models) {
      discoveredSet.add(`${probe.provider}/${modelId}`);
    }
  }

  for (const catalogModel of catalogModels) {
    const entry = catalog.models[catalogModel]!;
    // Only flag removals for providers we actually probed
    const probedProviders = new Set(probeResults.map((p) => p.provider));
    if (probedProviders.has(entry.provider) && !discoveredSet.has(catalogModel)) {
      diffs.push({
        model: catalogModel,
        status: 'removed',
        details: `Not found in ${entry.provider} /models response`,
      });
    }
  }

  return diffs;
}

function getDefaultBaseUrl(provider: string): string {
  switch (provider) {
    case 'openai': return 'https://api.openai.com';
    case 'anthropic': return 'https://api.anthropic.com';
    case 'ollama': return 'http://localhost:11434';
    default: return '';
  }
}

async function fetchModels(
  provider: string,
  baseUrl: string,
  apiKey: string
): Promise<string[]> {
  if (!baseUrl) return [];

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    if (provider === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
  }

  let url: string;
  if (provider === 'ollama') {
    url = `${baseUrl}/api/tags`;
  } else if (provider === 'anthropic') {
    url = `${baseUrl}/v1/models`;
  } else {
    url = `${baseUrl}/v1/models`;
  }

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    throw new Error(`${provider} /models returned ${response.status}`);
  }

  const data = (await response.json()) as Record<string, unknown>;

  if (provider === 'ollama') {
    const models = data.models as Array<{ name: string }> | undefined;
    return (models ?? []).map((m) => m.name);
  }

  const items = data.data as Array<{ id: string }> | undefined;
  return (items ?? []).map((m) => m.id);
}
