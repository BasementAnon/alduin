/**
 * Provider discovery -- probes local and self-hosted runtimes to
 * discover available models and add them to the catalog.
 *
 * Used by `alduin models sync` for Ollama and OpenAI-compatible endpoints.
 * Results are tagged with `source: "discovered"` and a `discovered_at`
 * timestamp so they can be distinguished from curated catalog entries.
 *
 */

import type { ModelEntry } from '../catalog/catalog.js';

/** A discovered model entry with provenance metadata. */
export interface DiscoveredModel {
  /** Fully qualified model ID (e.g. "ollama/llama3.2:7b"). */
  id: string;
  /** Partial catalog entry (missing fields get sensible defaults). */
  entry: ModelEntry;
  /** How this model was discovered. */
  source: 'discovered';
  /** ISO timestamp of when the model was discovered. */
  discovered_at: string;
}

/** Result of a discovery probe. */
export interface DiscoveryResult {
  /** Provider that was probed. */
  provider: string;
  /** Models discovered. */
  models: DiscoveredModel[];
  /** Error message if the probe failed. */
  error?: string;
}

// ── Ollama discovery ────────────────────────────────────────────────────────

/**
 * Probe an Ollama instance for available models via GET /api/tags.
 *
 * Ollama's /api/tags response shape:
 *   { models: [{ name, modified_at, size, digest, details: { format, family, parameter_size, quantization_level } }] }
 */
export async function discoverOllama(
  baseUrl = 'http://localhost:11434',
): Promise<DiscoveryResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/tags`;
  const now = new Date().toISOString();

  try {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return {
        provider: 'ollama',
        models: [],
        error: `Ollama /api/tags returned ${response.status}`,
      };
    }

    const data = (await response.json()) as {
      models?: Array<{
        name: string;
        modified_at?: string;
        size?: number;
        details?: {
          format?: string;
          family?: string;
          parameter_size?: string;
          quantization_level?: string;
        };
      }>;
    };

    const models: DiscoveredModel[] = (data.models ?? []).map((m) => {
      const modelName = m.name;
      return {
        id: `ollama/${modelName}`,
        entry: {
          provider: 'ollama',
          api_id: modelName,
          released: m.modified_at?.split('T')[0] ?? 'unknown',
          status: 'stable' as const,
          context_window: estimateOllamaContextWindow(m.details?.parameter_size),
          max_output_tokens: 4096,
          tokenizer: 'cl100k_base' as const,
          pricing_usd_per_mtok: { input: 0, output: 0 },
          capabilities: ['streaming'],
          deprecated: false,
          sunset_date: null,
        },
        source: 'discovered' as const,
        discovered_at: now,
      };
    });

    return { provider: 'ollama', models };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes('ECONNREFUSED') || message.includes('fetch')) {
      return { provider: 'ollama', models: [], error: 'Ollama not running or unreachable' };
    }
    return { provider: 'ollama', models: [], error: message };
  }
}

// ── OpenAI-compatible discovery ─────────────────────────────────────────────

/**
 * Probe an OpenAI-compatible endpoint for available models via GET /v1/models.
 *
 * Standard /v1/models response shape:
 *   { data: [{ id, created, owned_by }] }
 */
export async function discoverOpenAICompatible(
  baseUrl: string,
  apiKey: string,
): Promise<DiscoveryResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/models`;
  const now = new Date().toISOString();
  const provider = extractProviderName(baseUrl);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return {
        provider,
        models: [],
        error: `${provider} /v1/models returned ${response.status}`,
      };
    }

    const data = (await response.json()) as {
      data?: Array<{
        id: string;
        created?: number;
        owned_by?: string;
      }>;
    };

    const models: DiscoveredModel[] = (data.data ?? []).map((m) => {
      const createdDate = m.created
        ? new Date(m.created * 1000).toISOString().split('T')[0]
        : 'unknown';

      return {
        id: `${provider}/${m.id}`,
        entry: {
          provider,
          api_id: m.id,
          released: createdDate,
          status: 'stable' as const,
          context_window: 0,  // Unknown from /v1/models alone
          max_output_tokens: 0,
          tokenizer: 'cl100k_base' as const,
          pricing_usd_per_mtok: { input: 0, output: 0 },
          capabilities: [],
          deprecated: false,
          sunset_date: null,
        },
        source: 'discovered' as const,
        discovered_at: now,
      };
    });

    return { provider, models };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { provider, models: [], error: message };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Estimate Ollama model context window from parameter size string.
 * These are rough defaults -- the actual value depends on the specific model.
 */
function estimateOllamaContextWindow(parameterSize?: string): number {
  if (!parameterSize) return 4096;
  const lower = parameterSize.toLowerCase();
  if (lower.includes('70b') || lower.includes('65b')) return 32768;
  if (lower.includes('32b') || lower.includes('34b')) return 32768;
  if (lower.includes('13b') || lower.includes('14b')) return 16384;
  if (lower.includes('7b') || lower.includes('8b')) return 8192;
  if (lower.includes('3b') || lower.includes('1b')) return 4096;
  return 4096;
}

/**
 * Extract a provider name from a base URL.
 * "https://api.deepseek.com/v1" -> "deepseek"
 * "http://localhost:8080" -> "openai-compatible"
 */
function extractProviderName(baseUrl: string): string {
  try {
    const hostname = new URL(baseUrl).hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1') return 'openai-compatible';
    // Extract second-level domain: "api.deepseek.com" -> "deepseek"
    const parts = hostname.split('.');
    if (parts.length >= 2) return parts[parts.length - 2];
    return 'openai-compatible';
  } catch {
    return 'openai-compatible';
  }
}
