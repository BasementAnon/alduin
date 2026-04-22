/**
 * Composed AlduinConfig schema.
 *
 * Each domain is defined in its own module and assembled here.
 * This file is the single import point for anything that needs
 * the full schema or any of its parts.
 */
import { z } from 'zod';
import { orchestratorConfigSchema, executorConfigSchema, fallbacksSchema } from './models.js';
import { providersSchema } from './providers.js';
import { channelsConfigSchema } from './channels.js';
import {
  routingConfigSchema,
  budgetConfigSchema,
  memoryConfigSchema,
  tenantsConfigSchema,
  ingestionConfigSchema,
  pluginsConfigSchema,
} from './agents.js';

export * from './secrets.js';
export * from './models.js';
export * from './providers.js';
export * from './channels.js';
export * from './agents.js';

export const alduinConfigSchema = z.object({
  /** Catalog revision this config was validated against. */
  catalog_version: z.string().optional(),
  orchestrator: orchestratorConfigSchema,
  /** Named executor configurations. */
  executors: z.record(z.string(), executorConfigSchema),
  /** Named provider configurations. */
  providers: providersSchema,
  routing: routingConfigSchema,
  budgets: budgetConfigSchema,
  /** Ordered fallback chains: model → list of fallback models. */
  fallbacks: fallbacksSchema,
  memory: memoryConfigSchema.optional(),
  channels: channelsConfigSchema.optional(),
  tenants: tenantsConfigSchema.optional(),
  ingestion: ingestionConfigSchema.optional(),
  plugins: pluginsConfigSchema.optional(),
});

export type AlduinConfigInput = z.input<typeof alduinConfigSchema>;

/** Fully-validated Alduin runtime configuration (Zod output). */
export type AlduinConfig = z.output<typeof alduinConfigSchema>;
