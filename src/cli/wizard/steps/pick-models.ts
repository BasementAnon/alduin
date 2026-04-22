import { log, select } from '@clack/prompts';
import type { ModelCatalog } from '../../../catalog/catalog.js';
import type {
  ExecutorConfig,
  OrchestratorConfig,
  ProvidersConfig,
  RoutingConfig,
} from '../../../config/schema/index.js';
import { guard, providerOf } from '../helpers.js';
import type { ModelAnswers } from '../types.js';

// ── Default model sets ────────────────────────────────────────────────────────

/** Fallback model list when no catalog is available. */
const DEFAULT_MODELS = [
  'anthropic/claude-sonnet-4-6',
  'anthropic/claude-haiku-4',
  'openai/gpt-4.1',
  'openai/gpt-4.1-mini',
  'ollama/qwen2.5-7b',
];

/** Models suitable as the cheap classifier (fast + low cost). */
const CLASSIFIER_PREFERRED = [
  'anthropic/claude-haiku-4',
  'openai/gpt-4.1-mini',
  'ollama/qwen2.5-7b',
];

// ── Pure builders (tested) ────────────────────────────────────────────────────

/** Provider config shape produced by this step. */
export interface ModelsConfig {
  orchestrator: OrchestratorConfig;
  executors: Record<string, ExecutorConfig>;
  providers: ProvidersConfig;
  routing: RoutingConfig;
  fallbacks: Record<string, string[]>;
}

/**
 * Build orchestrator, executor, provider, routing, and fallback config sections
 * from the model selections.
 */
export function buildModelsConfig(answers: ModelAnswers): ModelsConfig {
  const { orchestratorModel, classifierModel } = answers;

  const orchestrator: OrchestratorConfig = {
    model: orchestratorModel,
    max_planning_tokens: 4000,
    context_strategy: 'sliding_window',
    context_window: 16000,
  };

  const executors: Record<string, ExecutorConfig> = {
    code: {
      model: orchestratorModel,
      max_tokens: 8000,
      tools: ['file_read', 'file_write', 'bash', 'git'],
      context: 'task_only',
    },
    research: {
      model: orchestratorModel,
      max_tokens: 4000,
      tools: ['web_search', 'web_fetch'],
      context: 'task_only',
    },
    content: {
      model: orchestratorModel,
      max_tokens: 6000,
      tools: [],
      context: 'task_plus_style_guide',
    },
    quick: {
      model: orchestratorModel,
      max_tokens: 2000,
      tools: ['calendar', 'email_read'],
      context: 'task_only',
    },
    classifier: {
      model: classifierModel,
      max_tokens: 200,
      tools: [],
      context: 'message_only',
    },
  };

  const providers: ProvidersConfig = buildProvidersConfig(
    orchestratorModel,
    classifierModel
  );

  const routing: RoutingConfig = {
    pre_classifier: true,
    classifier_model: 'classifier',
    complexity_threshold: 0.6,
  };

  // Simple fallback: if orchestrator is a paid API model, add local as fallback
  const fallbacks: Record<string, string[]> = {};
  if (!orchestratorModel.startsWith('ollama/')) {
    const localFallback = DEFAULT_MODELS.find((m) => m.startsWith('ollama/'));
    if (localFallback) {
      fallbacks[orchestratorModel] = [localFallback];
    }
  }

  return { orchestrator, executors, providers, routing, fallbacks };
}

/**
 * Infer the provider registry from the chosen model strings.
 * Providers are keyed by their alias (prefix before '/').
 */
export function buildProvidersConfig(
  orchestratorModel: string,
  classifierModel: string
): ProvidersConfig {
  const providers: ProvidersConfig = {};
  const modelProviders = new Set([
    providerOf(orchestratorModel),
    providerOf(classifierModel),
  ]);

  if (modelProviders.has('anthropic')) {
    providers['anthropic'] = { api_key_env: 'ANTHROPIC_API_KEY' };
  }
  if (modelProviders.has('openai')) {
    providers['openai'] = { api_key_env: 'OPENAI_API_KEY' };
  }
  if (modelProviders.has('ollama')) {
    providers['ollama'] = { base_url: 'http://localhost:11434' };
  }
  if (modelProviders.has('deepseek')) {
    providers['deepseek'] = {
      base_url: 'https://api.deepseek.com/v1',
      api_key_env: 'DEEPSEEK_API_KEY',
      api_type: 'openai-compatible',
    };
  }

  return providers;
}

// ── UI (not tested directly) ──────────────────────────────────────────────────

/**
 * Step 3 — pick orchestrator + classifier models from the active catalog.
 * Validates that both pins exist in the catalog before accepting.
 * Throws WizardCancelledError on Ctrl-C.
 */
export async function runPickModels(catalog: ModelCatalog | null): Promise<ModelAnswers> {
  const available = catalog
    ? catalog.listModels().filter((m) => !catalog.isDeprecated(m))
    : DEFAULT_MODELS;

  if (available.length === 0) {
    log.warn('No models found in catalog — using built-in defaults.');
    return {
      orchestratorModel: 'anthropic/claude-sonnet-4-6',
      classifierModel: 'anthropic/claude-haiku-4',
    };
  }

  const orchestratorModel = guard(
    await select<string>({
      message: 'Orchestrator model (plans, does not execute):',
      options: available.map((m) => {
        const entry = catalog?.getModel(m);
        const ctx =
          entry?.ok && entry.value.context_window
            ? `${(entry.value.context_window / 1000).toFixed(0)}k ctx`
            : '';
        return { label: m, value: m, hint: ctx };
      }),
      initialValue: available.includes('anthropic/claude-sonnet-4-6')
        ? 'anthropic/claude-sonnet-4-6'
        : available[0],
    })
  );

  // Suggest cheap classifier models first
  const classifierOptions = [
    ...CLASSIFIER_PREFERRED.filter((m) => available.includes(m)),
    ...available.filter((m) => !CLASSIFIER_PREFERRED.includes(m)),
  ];

  const classifierModel = guard(
    await select<string>({
      message: 'Classifier model (cheap/fast — scores message complexity):',
      options: classifierOptions.map((m) => ({
        label: m,
        value: m,
        hint: CLASSIFIER_PREFERRED.includes(m) ? 'recommended' : undefined,
      })),
      initialValue: classifierOptions[0],
    })
  );

  // Validate catalog pins
  if (catalog) {
    for (const model of [orchestratorModel, classifierModel]) {
      const result = catalog.getModel(model);
      if (!result.ok) {
        log.warn(`Warning: ${result.error.message}`);
      }
    }
  }

  return { orchestratorModel, classifierModel };
}
