/**
 * Re-exports all public TypeScript types derived from the Alduin config schema.
 *
 * Consumers should import from this file (or from '@/config') — not from
 * individual schema domain files — so import paths remain stable as the
 * domain layout evolves.
 */
export type {
  SecretRef,
  SecretInput,
  ExecutorContext,
  ExecutorConfig,
  OrchestratorConfig,
  FallbacksConfig,
  ProviderConfig,
  ProvidersConfig,
  TelegramChannelConfig,
  ChannelsConfig,
  RoutingConfig,
  BudgetConfig,
  MemoryConfig,
  TenantsConfig,
  IngestionConfig,
  PluginsConfig,
  AlduinConfigInput,
  AlduinConfig,
} from './schema/index.js';
