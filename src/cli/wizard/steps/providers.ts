/**
 * Step 2 — Provider setup.
 *
 * Multi-select providers, collect API keys (password-masked), validate
 * key format, test connectivity, write keys to vault. Supports:
 *   - Anthropic (cloud)
 *   - OpenAI (cloud)
 *   - DeepSeek (cloud, openai-compatible)
 *   - Ollama (local)
 *   - OpenAI-compatible (custom endpoint)
 */

import { confirm, log, multiselect, password, spinner, text } from '@clack/prompts';
import type { CredentialVault } from '../../../secrets/vault.js';
import { guard } from '../helpers.js';
import type { ProviderAnswers, ProviderSetup } from '../types.js';

// ── Provider definitions ──────────────────────────────────────────────────────

interface ProviderDef {
  id: string;
  label: string;
  hint: string;
  cloud: boolean;
  keyEnv: string;
  vaultScope: string;
  baseUrl?: string;
  apiType?: string;
  validateKey?: (key: string) => string | undefined;
  testUrl?: (baseUrl?: string) => string;
}

const PROVIDER_DEFS: ProviderDef[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    hint: 'Claude models (Sonnet, Haiku, Opus)',
    cloud: true,
    keyEnv: 'ANTHROPIC_API_KEY',
    vaultScope: 'providers/anthropic/api_key',
    validateKey: (key) => {
      if (!key.startsWith('sk-ant-')) return 'Anthropic keys start with "sk-ant-"';
      if (key.length < 20) return 'Key appears too short';
      return undefined;
    },
    testUrl: () => 'https://api.anthropic.com/v1/messages',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    hint: 'GPT-4.1, GPT-4.1-mini, o-series',
    cloud: true,
    keyEnv: 'OPENAI_API_KEY',
    vaultScope: 'providers/openai/api_key',
    validateKey: (key) => {
      if (!key.startsWith('sk-')) return 'OpenAI keys start with "sk-"';
      if (key.length < 20) return 'Key appears too short';
      return undefined;
    },
    testUrl: () => 'https://api.openai.com/v1/models',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    hint: 'DeepSeek V3, R1 — affordable reasoning',
    cloud: true,
    keyEnv: 'DEEPSEEK_API_KEY',
    vaultScope: 'providers/deepseek/api_key',
    baseUrl: 'https://api.deepseek.com/v1',
    apiType: 'openai-compatible',
    validateKey: (key) => {
      if (key.length < 10) return 'Key appears too short';
      return undefined;
    },
    testUrl: () => 'https://api.deepseek.com/v1/models',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    hint: 'Run models locally — no API key needed',
    cloud: false,
    keyEnv: '',
    vaultScope: '',
    baseUrl: 'http://localhost:11434',
    testUrl: (base) => `${base ?? 'http://localhost:11434'}/api/tags`,
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible (custom)',
    hint: 'Together, Fireworks, LM Studio, etc.',
    cloud: true,
    keyEnv: 'CUSTOM_LLM_API_KEY',
    vaultScope: 'providers/custom/api_key',
    apiType: 'openai-compatible',
    validateKey: (key) => {
      if (key.length < 5) return 'Key appears too short';
      return undefined;
    },
  },
];

// ── Vault scope keys ──────────────────────────────────────────────────────────

export function providerVaultScope(providerId: string): string {
  const def = PROVIDER_DEFS.find((d) => d.id === providerId);
  return def?.vaultScope ?? `providers/${providerId}/api_key`;
}

// ── Connectivity tests ────────────────────────────────────────────────────────

async function testProviderConnectivity(
  def: ProviderDef,
  apiKey: string | undefined,
  baseUrl: string | undefined
): Promise<{ ok: boolean; error?: string; latencyMs: number }> {
  const testFn = def.testUrl;
  if (!testFn) return { ok: true, latencyMs: 0 };

  const url = testFn(baseUrl);
  const start = Date.now();

  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };

    if (def.id === 'anthropic' && apiKey) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      // Use a minimal request to test auth
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-haiku-4-20250414',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const latencyMs = Date.now() - start;
      // 200 or 400 (bad model) both prove auth works; 401/403 means bad key
      if (res.status === 401 || res.status === 403) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        return { ok: false, latencyMs, error: body.error?.message ?? `HTTP ${res.status}` };
      }
      return { ok: true, latencyMs };
    }

    if (def.id === 'openai' && apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    } else if (def.id === 'deepseek' && apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    } else if (def.id === 'openai-compatible' && apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    const latencyMs = Date.now() - start;

    if (res.status === 401 || res.status === 403) {
      return { ok: false, latencyMs, error: `Authentication failed (HTTP ${res.status})` };
    }
    if (!res.ok && res.status !== 404) {
      return { ok: false, latencyMs, error: `HTTP ${res.status}` };
    }

    return { ok: true, latencyMs };
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── Builder (pure, tested) ────────────────────────────────────────────────────

export interface ProvidersConfigOutput {
  providers: Record<string, {
    api_key_env?: string;
    base_url?: string;
    api_type?: string;
  }>;
}

export function buildProvidersConfig(answers: ProviderAnswers): ProvidersConfigOutput {
  const providers: ProvidersConfigOutput['providers'] = {};

  for (const p of answers.providers) {
    const def = PROVIDER_DEFS.find((d) => d.id === p.id);
    const entry: Record<string, string> = {};

    if (def?.keyEnv && p.apiKey) {
      entry['api_key_env'] = def.keyEnv;
    }
    if (p.baseUrl) {
      entry['base_url'] = p.baseUrl;
    }
    if (p.apiType ?? def?.apiType) {
      entry['api_type'] = p.apiType ?? def?.apiType ?? '';
    }

    providers[p.id] = entry;
  }

  return { providers };
}

// ── Vault writes ──────────────────────────────────────────────────────────────

/**
 * Stored vault scopes for cleanup on Ctrl-C.
 * Centralized: all wizard steps (providers, channel, etc.) push here
 * so Ctrl-C cleanup removes everything written during the incomplete run.
 */
const writtenVaultScopes: string[] = [];

export function getWrittenVaultScopes(): string[] {
  return [...writtenVaultScopes];
}

/** Register additional vault scopes for Ctrl-C cleanup (used by channel step). */
export function trackVaultScope(scope: string): void {
  writtenVaultScopes.push(scope);
}

export function writeProviderKeysToVault(
  vault: CredentialVault,
  answers: ProviderAnswers
): void {
  vault.transaction(() => {
    for (const p of answers.providers) {
      if (p.apiKey) {
        const scope = providerVaultScope(p.id);
        vault.set(scope, p.apiKey);
        writtenVaultScopes.push(scope);
      }
    }
  });
}

export function cleanupVaultScopes(vault: CredentialVault): void {
  if (writtenVaultScopes.length === 0) return;
  vault.transaction(() => {
    for (const scope of writtenVaultScopes) {
      vault.delete(scope);
    }
  });
  writtenVaultScopes.length = 0;
}

// ── UI ────────────────────────────────────────────────────────────────────────

export async function runProviderSetup(vault: CredentialVault): Promise<ProviderAnswers> {
  const selectedIds = guard(
    await multiselect<string>({
      message: 'Which LLM providers will you use? (space to select, enter to confirm)',
      options: PROVIDER_DEFS.map((d) => ({
        label: d.label,
        value: d.id,
        hint: d.hint,
      })),
      required: true,
    })
  );

  const setups: ProviderSetup[] = [];

  for (const id of selectedIds) {
    const def = PROVIDER_DEFS.find((d) => d.id === id)!;
    const setup: ProviderSetup = { id, connected: false };

    if (def.cloud) {
      // Collect API key
      const rawKey = guard(
        await password({
          message: `${def.label} API key:`,
          mask: '*',
          validate: (v) => {
            if (!v || v.trim().length === 0) return 'API key is required';
            if (def.validateKey) return def.validateKey(v.trim());
            return undefined;
          },
        })
      );
      setup.apiKey = rawKey.trim();
    }

    // Ollama or custom: collect base URL
    if (id === 'ollama') {
      const baseUrl = guard(
        await text({
          message: 'Ollama base URL:',
          initialValue: def.baseUrl ?? 'http://localhost:11434',
          placeholder: 'http://localhost:11434',
          validate: (v) => {
            if (!v) return 'URL is required';
            try {
              new URL(v);
              return undefined;
            } catch {
              return 'Must be a valid URL';
            }
          },
        })
      );
      setup.baseUrl = baseUrl.trim();
    } else if (id === 'openai-compatible') {
      const baseUrl = guard(
        await text({
          message: 'API base URL (OpenAI-compatible endpoint):',
          placeholder: 'https://api.together.ai/v1',
          validate: (v) => {
            if (!v) return 'URL is required';
            try {
              new URL(v);
              return undefined;
            } catch {
              return 'Must be a valid URL';
            }
          },
        })
      );
      setup.baseUrl = baseUrl.trim();
      setup.apiType = 'openai-compatible';
    } else if (def.baseUrl) {
      setup.baseUrl = def.baseUrl;
    }

    if (def.apiType) {
      setup.apiType = def.apiType;
    }

    // Store API key in vault immediately
    if (setup.apiKey) {
      const scope = providerVaultScope(id);
      vault.set(scope, setup.apiKey);
      writtenVaultScopes.push(scope);
    }

    setups.push(setup);
  }

  // Connectivity tests
  const s = spinner();
  for (const setup of setups) {
    const def = PROVIDER_DEFS.find((d) => d.id === setup.id)!;
    s.start(`Testing ${def.label} connectivity…`);

    const result = await testProviderConnectivity(def, setup.apiKey, setup.baseUrl);
    setup.connected = result.ok;

    if (result.ok) {
      s.stop(`${def.label} ✓ (${result.latencyMs}ms)`);
    } else {
      s.stop(`${def.label} ✗ — ${result.error ?? 'connection failed'}`);

      const retry = guard(
        await confirm({
          message: `${def.label} connectivity failed. Re-enter credentials or skip?`,
          initialValue: true,
          active: 'Re-enter',
          inactive: 'Skip (configure later)',
        })
      );

      if (retry && def.cloud) {
        const rawKey = guard(
          await password({
            message: `${def.label} API key (retry):`,
            mask: '*',
          })
        );
        setup.apiKey = rawKey.trim();

        // Update vault
        const scope = providerVaultScope(setup.id);
        vault.set(scope, setup.apiKey);

        s.start(`Re-testing ${def.label}…`);
        const retryResult = await testProviderConnectivity(def, setup.apiKey, setup.baseUrl);
        setup.connected = retryResult.ok;
        s.stop(
          retryResult.ok
            ? `${def.label} ✓ (${retryResult.latencyMs}ms)`
            : `${def.label} ✗ — continuing anyway`
        );
      }
    }
  }

  // Summary
  const passCount = setups.filter((s) => s.connected).length;
  const totalCount = setups.length;
  if (passCount === totalCount) {
    log.success(`All ${totalCount} provider(s) connected successfully.`);
  } else {
    log.warn(`${passCount}/${totalCount} provider(s) connected. Failed providers may not work at runtime.`);
  }

  return { providers: setups };
}
