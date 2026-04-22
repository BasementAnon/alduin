/**
 * Backward-compatibility shim.
 * All schema symbols now live under src/config/schema/.
 * Import from './schema/index.js' (or '@/config') in new code.
 */
export {
  secretRefSchema,
  secretInputSchema,
  modelStringSchema,
  executorContextSchema,
  executorConfigSchema,
  orchestratorConfigSchema,
  fallbacksSchema,
  providerConfigSchema,
  providersSchema,
  telegramChannelConfigSchema,
  channelsConfigSchema,
  routingConfigSchema,
  budgetConfigSchema,
  memoryConfigSchema,
  tenantsConfigSchema,
  ingestionConfigSchema,
  alduinConfigSchema,
} from './schema/index.js';

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
  AlduinConfigInput,
  AlduinConfig,
} from './schema/index.js';
