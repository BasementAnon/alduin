export type {
  AlduinConfig,
  AlduinConfigInput,
  OrchestratorConfig,
  ExecutorConfig,
  ExecutorContext,
  FallbacksConfig,
  ProviderConfig,
  ProvidersConfig,
  RoutingConfig,
  BudgetConfig,
  MemoryConfig,
  TelegramChannelConfig,
  ChannelsConfig,
  TenantsConfig,
  IngestionConfig,
  SecretRef,
  SecretInput,
} from './schema/index.js';

export { loadConfig } from './loader.js';
export type { ConfigError } from './loader.js';

export {
  alduinConfigSchema,
  orchestratorConfigSchema,
  executorConfigSchema,
  executorContextSchema,
  modelStringSchema,
  providerConfigSchema,
  providersSchema,
  routingConfigSchema,
  budgetConfigSchema,
  memoryConfigSchema,
  telegramChannelConfigSchema,
  channelsConfigSchema,
  tenantsConfigSchema,
  ingestionConfigSchema,
  fallbacksSchema,
  secretRefSchema,
  secretInputSchema,
} from './schema/index.js';
