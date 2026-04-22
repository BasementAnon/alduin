import type { LLMProvider } from '../types/llm.js';
import type { AlduinConfig } from '../config/types.js';
import type { PluginRegistry } from '../plugins/registry.js';

/** Known provider API-key environment variable names (legacy backstop). */
const PROVIDER_ENV_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
  'GOOGLE_API_KEY',
] as const;

/** Standard vault and audit secret environment variable names. */
const VAULT_SECRET_KEYS = [
  'ALDUIN_VAULT_SECRET',
  'ALDUIN_AUDIT_HMAC_KEY',
] as const;

/**
 * Delete all secrets consumed at initialization from `process.env`.
 *
 * Scrubs:
 * - Every env var name appearing in config.providers[*].api_key_env
 * - Legacy hardcoded provider keys (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.)
 * - Vault/audit secrets (ALDUIN_VAULT_SECRET, ALDUIN_AUDIT_HMAC_KEY)
 * - Telegram token env vars from config.channels.telegram
 *
 * Call this immediately after all secrets have been consumed so they are not
 * inherited by any child processes spawned later.
 *
 * Invariant: All credentials that were read from process.env during init must
 * be removed before any child process can spawn.
 */
export function scrubSecretEnv(config: AlduinConfig): void {
  const keysToDelete = new Set<string>();

  // 1. Legacy hardcoded provider keys (always attempt to delete as backstop)
  for (const key of PROVIDER_ENV_KEYS) {
    keysToDelete.add(key);
  }

  // 2. Dynamic provider API key env vars from config
  for (const provider of Object.values(config.providers)) {
    if (provider.api_key_env) {
      keysToDelete.add(provider.api_key_env);
    }
  }

  // 3. Vault and audit secrets
  for (const key of VAULT_SECRET_KEYS) {
    keysToDelete.add(key);
  }

  // 4. Telegram channel tokens
  if (config.channels?.telegram?.token_env) {
    keysToDelete.add(config.channels.telegram.token_env);
  }
  if (config.channels?.telegram?.webhook_secret_env) {
    keysToDelete.add(config.channels.telegram.webhook_secret_env);
  }

  // Delete all identified keys
  for (const key of keysToDelete) {
    delete process.env[key];
  }
}

/**
 * Registry of LLM provider instances.
 *
 * Providers are registered at startup from config (legacy path) or resolved
 * through the PluginRegistry (plugin path). The plugin registry is consulted
 * as a fallback when a provider ID is not found in the local map.
 *
 * Public API is unchanged -- callers don't need to know whether a provider
 * came from a plugin or from the hardcoded init path.
 */
export class ProviderRegistry {
  private providers: Map<string, LLMProvider> = new Map();
  private pluginRegistry: PluginRegistry | null = null;

  /**
   * Attach a PluginRegistry for fallback resolution.
   * Called during bootstrap after plugins are loaded.
   * When set, get()/resolveProvider() will consult the plugin registry
   * if the provider is not in the local map.
   *
   * Note: PluginRegistry providers use the ProviderPlugin interface
   * (plugin-sdk), not LLMProvider. This fallback returns undefined for
   * now -- full bridge is wired in Prompt 2.4. The linkage exists so
   * `alduin plugins list` can enumerate plugin-backed providers.
   */
  setPluginRegistry(registry: PluginRegistry): void {
    this.pluginRegistry = registry;
  }

  /** Get the attached plugin registry, if any. */
  getPluginRegistry(): PluginRegistry | null {
    return this.pluginRegistry;
  }

  /** Register a provider by its ID */
  register(id: string, provider: LLMProvider): void {
    this.providers.set(id, provider);
  }

  /** Get a provider by ID */
  get(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * Resolve a model string to its provider.
   * Model strings are formatted as "provider/model-name".
   * Returns the provider instance or undefined if not registered.
   */
  resolveProvider(modelString: string): LLMProvider | undefined {
    const providerId = modelString.split('/')[0];
    if (!providerId) return undefined;
    return this.providers.get(providerId);
  }

  /**
   * Extract the model name from a fully qualified model string.
   * "anthropic/claude-sonnet-4-6" -> "claude-sonnet-4-6"
   */
  resolveModelName(modelString: string): string {
    const parts = modelString.split('/');
    return parts.slice(1).join('/');
  }

  /**
   * List all registered provider IDs.
   * Merges local providers with plugin-registry providers.
   */
  listProviders(): string[] {
    const local = Array.from(this.providers.keys());
    if (!this.pluginRegistry) return local;

    const pluginProviders = this.pluginRegistry.listProviderIds();
    const merged = new Set([...local, ...pluginProviders]);
    return Array.from(merged);
  }

  /** Check if a provider is registered (local or plugin). */
  has(id: string): boolean {
    if (this.providers.has(id)) return true;
    if (this.pluginRegistry?.hasProvider(id)) return true;
    return false;
  }
}
