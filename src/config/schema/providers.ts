import { z } from 'zod';

export const providerConfigSchema = z.object({
  /** Name of the environment variable holding the API key. */
  api_key_env: z.string().optional(),
  /** Base URL for self-hosted or custom-endpoint providers. */
  base_url: z.string().url('base_url must be a valid URL').optional(),
  /** 'openai-compatible' enables the OpenAI SDK with a custom base URL. */
  api_type: z.string().optional(),
});

/** Configuration for a single LLM provider. */
export type ProviderConfig = z.output<typeof providerConfigSchema>;

/** Named provider configurations, keyed by provider alias (e.g. "anthropic"). */
export const providersSchema = z.record(z.string(), providerConfigSchema);

export type ProvidersConfig = z.output<typeof providersSchema>;
