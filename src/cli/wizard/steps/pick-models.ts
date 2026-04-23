/**
 * Step 3 — Model assignment.
 *
 * Queries the catalog for models from providers the user configured in Step 2.
 * Offers a fast-track (recommended defaults) or per-role customization.
 *
 * Roles: orchestrator, classifier, code, research, content, quick.
 * Shows estimated cost-per-call for each selection.
 */

import { confirm, log, select } from '@clack/prompts';
import type { ModelCatalog } from '../../../catalog/catalog.js';
import type {
  ExecutorConfig,
  OrchestratorConfig,
  ProvidersConfig,
  RoutingConfig,
} from '../../../config/schema/index.js';
import { guard, providerOf } from '../helpers.js';
import type { ModelAnswers, ModelAssignment, ProviderAnswers } from '../types.js';

// ── Role descriptions ─────────────────────────────────────────────────────────

interface RoleInfo {
  key: keyof ModelAssignment;
  label: string;
  description: string;
  preference: 'capable' | 'cheap' | 'balanced';
  maxTokens: number;
  tools: string[];
  context: 'task_only' | 'task_plus_style_guide' | 'message_only';
}

const ROLES: RoleInfo[] = [
  {
    key: 'orchestrator',
    label: 'Orchestrator',
    description: 'Plans task decomposition — the most capable model available',
    preference: 'capable',
    maxTokens: 4000,
    tools: [],
    context: 'task_only',
  },
  {
    key: 'classifier',
    label: 'Classifier',
    description: 'Pre-routes messages — cheapest/fastest, sees only raw message',
    preference: 'cheap',
    maxTokens: 200,
    tools: [],
    context: 'message_only',
  },
  {
    key: 'code',
    label: 'Code executor',
    description: 'Writes and reviews code — strong coding model',
    preference: 'capable',
    maxTokens: 8000,
    tools: ['file_read', 'file_write', 'bash', 'git'],
    context: 'task_only',
  },
  {
    key: 'research',
    label: 'Research executor',
    description: 'Web research and analysis — can differ from code',
    preference: 'balanced',
    maxTokens: 4000,
    tools: ['web_search', 'web_fetch'],
    context: 'task_only',
  },
  {
    key: 'content',
    label: 'Content executor',
    description: 'Writing tasks — style-guide-aware',
    preference: 'balanced',
    maxTokens: 6000,
    tools: [],
    context: 'task_plus_style_guide',
  },
  {
    key: 'quick',
    label: 'Quick executor',
    description: 'Simple lookups — cheapest model for fast single-step tasks',
    preference: 'cheap',
    maxTokens: 2000,
    tools: ['calendar', 'email_read'],
    context: 'task_only',
  },
];

// ── Default model ranking per preference ──────────────────────────────────────

const CAPABLE_PREFERENCE = [
  'anthropic/claude-sonnet-4-6',
  'anthropic/claude-opus-4-6',
  'openai/gpt-4.1',
  'deepseek/deepseek-v3.2',
  'ollama/qwen2.5-7b',
];

const CHEAP_PREFERENCE = [
  'anthropic/claude-haiku-4',
  'openai/gpt-4.1-mini',
  'deepseek/deepseek-v3.2',
  'ollama/qwen2.5-7b',
];

const BALANCED_PREFERENCE = [
  'anthropic/claude-sonnet-4-6',
  'openai/gpt-4.1',
  'deepseek/deepseek-v3.2',
  'ollama/qwen2.5-7b',
];

function preferenceList(pref: 'capable' | 'cheap' | 'balanced'): string[] {
  switch (pref) {
    case 'capable': return CAPABLE_PREFERENCE;
    case 'cheap': return CHEAP_PREFERENCE;
    case 'balanced': return BALANCED_PREFERENCE;
  }
}

// ── Pure builders (tested) ────────────────────────────────────────────────────

export interface ModelsConfig {
  orchestrator: OrchestratorConfig;
  executors: Record<string, ExecutorConfig>;
  providers: ProvidersConfig;
  routing: RoutingConfig;
  fallbacks: Record<string, string[]>;
}

export function buildModelsConfig(answers: ModelAnswers): ModelsConfig {
  const a = answers.assignments;

  const orchestrator: OrchestratorConfig = {
    model: a.orchestrator,
    max_planning_tokens: 4000,
    context_strategy: 'sliding_window',
    context_window: 16000,
  };

  const executors: Record<string, ExecutorConfig> = {};
  for (const role of ROLES) {
    if (role.key === 'orchestrator') continue;
    executors[role.key] = {
      model: a[role.key],
      max_tokens: role.maxTokens,
      tools: role.tools,
      context: role.context,
    };
  }

  // Build providers from all unique model providers
  const allModels = Object.values(a);
  const providers = buildProvidersFromModels(allModels);

  const routing: RoutingConfig = {
    pre_classifier: true,
    classifier_model: 'classifier',
    complexity_threshold: 0.6,
  };

  // Build fallback chains
  const fallbacks: Record<string, string[]> = {};
  const uniqueModels = [...new Set(allModels)];
  for (const model of uniqueModels) {
    if (!model.startsWith('ollama/')) {
      const fallbackCandidates = uniqueModels.filter(
        (m) => m !== model && providerOf(m) !== providerOf(model)
      );
      if (fallbackCandidates.length > 0) {
        fallbacks[model] = fallbackCandidates.slice(0, 2);
      }
    }
  }

  return { orchestrator, executors, providers, routing, fallbacks };
}

export function buildProvidersFromModels(models: string[]): ProvidersConfig {
  const providers: ProvidersConfig = {};
  const seen = new Set<string>();

  for (const model of models) {
    const provider = providerOf(model);
    if (seen.has(provider)) continue;
    seen.add(provider);

    switch (provider) {
      case 'anthropic':
        providers['anthropic'] = { api_key_env: 'ANTHROPIC_API_KEY' };
        break;
      case 'openai':
        providers['openai'] = { api_key_env: 'OPENAI_API_KEY' };
        break;
      case 'ollama':
        providers['ollama'] = { base_url: 'http://localhost:11434' };
        break;
      case 'deepseek':
        providers['deepseek'] = {
          base_url: 'https://api.deepseek.com/v1',
          api_key_env: 'DEEPSEEK_API_KEY',
          api_type: 'openai-compatible',
        };
        break;
      default:
        providers[provider] = { api_key_env: `${provider.toUpperCase()}_API_KEY` };
    }
  }

  return providers;
}

/** Build providers config from ProviderAnswers (Step 2 output). */
export function buildProvidersConfigFromSetup(providerAnswers: ProviderAnswers): ProvidersConfig {
  const providers: ProvidersConfig = {};

  for (const p of providerAnswers.providers) {
    const entry: Record<string, string> = {};

    switch (p.id) {
      case 'anthropic':
        entry['api_key_env'] = 'ANTHROPIC_API_KEY';
        break;
      case 'openai':
        entry['api_key_env'] = 'OPENAI_API_KEY';
        break;
      case 'deepseek':
        entry['api_key_env'] = 'DEEPSEEK_API_KEY';
        entry['base_url'] = p.baseUrl ?? 'https://api.deepseek.com/v1';
        entry['api_type'] = 'openai-compatible';
        break;
      case 'ollama':
        entry['base_url'] = p.baseUrl ?? 'http://localhost:11434';
        break;
      case 'openai-compatible':
        if (p.baseUrl) entry['base_url'] = p.baseUrl;
        entry['api_key_env'] = 'CUSTOM_LLM_API_KEY';
        entry['api_type'] = 'openai-compatible';
        break;
    }

    providers[p.id] = entry;
  }

  return providers;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function estimateCostPerCall(
  model: string,
  inputTokens: number,
  outputTokens: number,
  catalog: ModelCatalog | null
): string {
  const pricing = catalog?.getPricing(model);
  if (!pricing) return '(pricing unknown)';
  const cost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  if (cost < 0.0001) return '<$0.0001';
  return `~$${cost.toFixed(4)}`;
}

function getAvailableModels(
  catalog: ModelCatalog | null,
  configuredProviders: string[]
): string[] {
  if (!catalog) return [];

  return catalog
    .listModels()
    .filter((m) => !catalog.isDeprecated(m))
    .filter((m) => configuredProviders.includes(providerOf(m)));
}

function pickDefault(
  available: string[],
  preference: string[]
): string | undefined {
  for (const pref of preference) {
    if (available.includes(pref)) return pref;
  }
  return available[0];
}

// ── UI ────────────────────────────────────────────────────────────────────────

export async function runPickModels(
  catalog: ModelCatalog | null,
  providerAnswers: ProviderAnswers
): Promise<ModelAnswers> {
  const configuredProviderIds = providerAnswers.providers.map((p) => p.id);
  const available = getAvailableModels(catalog, configuredProviderIds);

  if (available.length === 0) {
    log.warn(
      'No models found in the catalog for your configured providers. Using built-in defaults.'
    );
    const fallbackModel =
      configuredProviderIds.includes('anthropic')
        ? 'anthropic/claude-sonnet-4-6'
        : configuredProviderIds.includes('openai')
          ? 'openai/gpt-4.1'
          : `${configuredProviderIds[0] ?? 'ollama'}/default`;

    const cheapModel =
      configuredProviderIds.includes('anthropic')
        ? 'anthropic/claude-haiku-4'
        : configuredProviderIds.includes('openai')
          ? 'openai/gpt-4.1-mini'
          : fallbackModel;

    return {
      assignments: {
        orchestrator: fallbackModel,
        classifier: cheapModel,
        code: fallbackModel,
        research: fallbackModel,
        content: fallbackModel,
        quick: cheapModel,
      },
      usedDefaults: true,
    };
  }

  // Build recommended defaults
  const defaults: ModelAssignment = {
    orchestrator: pickDefault(available, preferenceList('capable')) ?? available[0]!,
    classifier: pickDefault(available, preferenceList('cheap')) ?? available[0]!,
    code: pickDefault(available, preferenceList('capable')) ?? available[0]!,
    research: pickDefault(available, preferenceList('balanced')) ?? available[0]!,
    content: pickDefault(available, preferenceList('balanced')) ?? available[0]!,
    quick: pickDefault(available, preferenceList('cheap')) ?? available[0]!,
  };

  // Fast-track offer
  const useDefaults = guard(
    await confirm({
      message:
        'Use recommended model defaults for your providers?\n' +
        `  Orchestrator: ${defaults.orchestrator}\n` +
        `  Classifier:   ${defaults.classifier}\n` +
        `  Executors:     ${defaults.code} (code/research/content), ${defaults.quick} (quick)`,
      initialValue: true,
    })
  );

  if (useDefaults) {
    log.success('Using recommended model defaults.');
    return { assignments: defaults, usedDefaults: true };
  }

  // Same model for all executors shortcut
  const sameForAll = guard(
    await confirm({
      message: 'Use the same model for all executor roles? (simpler setup)',
      initialValue: false,
    })
  );

  if (sameForAll) {
    const model = guard(
      await select<string>({
        message: 'Model for all executors:',
        options: available.map((m) => ({
          label: m,
          value: m,
          hint: estimateCostPerCall(m, 1000, 500, catalog),
        })),
        initialValue: defaults.orchestrator,
      })
    );

    const classifierModel = guard(
      await select<string>({
        message: 'Classifier model (cheap/fast for pre-routing):',
        options: available.map((m) => ({
          label: m,
          value: m,
          hint: estimateCostPerCall(m, 200, 50, catalog),
        })),
        initialValue: defaults.classifier,
      })
    );

    return {
      assignments: {
        orchestrator: model,
        classifier: classifierModel,
        code: model,
        research: model,
        content: model,
        quick: model,
      },
      usedDefaults: false,
    };
  }

  // Per-role customization
  const assignments: Partial<ModelAssignment> = {};

  for (const role of ROLES) {
    const prefList = preferenceList(role.preference);
    const sorted = [
      ...prefList.filter((m) => available.includes(m)),
      ...available.filter((m) => !prefList.includes(m)),
    ];

    const avgInput = role.key === 'classifier' ? 200 : role.key === 'quick' ? 500 : 1000;
    const avgOutput = role.key === 'classifier' ? 50 : role.key === 'quick' ? 200 : 500;

    const model = guard(
      await select<string>({
        message: `${role.label}: ${role.description}`,
        options: sorted.map((m) => {
          const entry = catalog?.getModel(m);
          const ctx =
            entry?.ok && entry.value.context_window
              ? `${(entry.value.context_window / 1000).toFixed(0)}k ctx`
              : '';
          const cost = estimateCostPerCall(m, avgInput, avgOutput, catalog);
          const hint = [ctx, cost].filter(Boolean).join(' · ');
          return { label: m, value: m, hint };
        }),
        initialValue: pickDefault(sorted, prefList) ?? sorted[0],
      })
    );

    assignments[role.key] = model;
  }

  return {
    assignments: assignments as ModelAssignment,
    usedDefaults: false,
  };
}
