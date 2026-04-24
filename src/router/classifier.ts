import type { AlduinConfig } from '../config/types.js';
import type { LLMError } from '../types/llm.js';
import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';
import { ProviderRegistry } from '../providers/registry.js';
import { TokenCounter } from '../tokens/counter.js';
import type { ClassificationResult, MessageCategory, MessageComplexity } from './types.js';

const VALID_CATEGORIES: MessageCategory[] = [
  'code', 'research', 'content', 'ops', 'conversation', 'multi_step',
];
const VALID_COMPLEXITIES: MessageComplexity[] = ['low', 'medium', 'high'];

/** Fallback when classifier is unavailable or response is unparseable */
const DEFAULT_CLASSIFICATION: ClassificationResult = {
  complexity: 'medium',
  category: 'multi_step',
  suggested_executor: null,
  needs_orchestrator: true,
  confidence: 0.0,
  reasoning: 'Classifier unavailable, defaulting to orchestrator',
};

/**
 * Pre-classifier that routes messages before the orchestrator sees them.
 * Sends ONLY the user's message to a cheap/fast model — no conversation
 * history, no tools, no system prompt bloat.
 */
export class MessageClassifier {
  private providerRegistry: ProviderRegistry;
  private config: AlduinConfig;
  private tokenCounter: TokenCounter;
  private systemPrompt: string;

  constructor(
    providerRegistry: ProviderRegistry,
    config: AlduinConfig,
    tokenCounter: TokenCounter
  ) {
    this.providerRegistry = providerRegistry;
    this.config = config;
    this.tokenCounter = tokenCounter;
    this.systemPrompt = this.buildSystemPrompt();
  }

  /**
   * Classify a user message to determine the optimal routing path.
   * On any error (provider unavailable, parse failure) returns the safe default
   * of routing to the orchestrator.
   */
  async classify(message: string): Promise<Result<ClassificationResult, LLMError>> {
    const classifierExecutorName = this.config.routing.classifier_model;
    const executorConfig = this.config.executors[classifierExecutorName];

    if (!executorConfig) {
      return ok({ ...DEFAULT_CLASSIFICATION });
    }

    const modelString = executorConfig.model;
    const provider = this.providerRegistry.resolveProvider(modelString);

    if (!provider) {
      return ok({ ...DEFAULT_CLASSIFICATION });
    }

    const modelName = this.providerRegistry.resolveModelName(modelString);

    const result = await provider.complete({
      model: modelName,
      messages: [
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: message },
      ],
      max_tokens: 200,
    });

    if (!result.ok) {
      // Return a default classification rather than propagating the error,
      // since a classifier failure is recoverable — just route to orchestrator.
      console.warn(`[Classifier] LLM call failed (${result.error.type}): ${result.error.message} — routing to orchestrator`);
      return ok({ ...DEFAULT_CLASSIFICATION, reasoning: result.error.message });
    }

    const parsed = this.parseAndValidate(result.value.content);
    return ok(parsed);
  }

  /**
   * Parse and validate the model's JSON response.
   * Falls back to the default classification on any issue.
   */
  private parseAndValidate(content: string): ClassificationResult {
    try {
      let cleaned = content.trim();
      // Strip markdown fences if present
      if (cleaned.startsWith('```')) {
        const nl = cleaned.indexOf('\n');
        const lastFence = cleaned.lastIndexOf('```');
        if (nl !== -1 && lastFence > nl) {
          cleaned = cleaned.slice(nl + 1, lastFence).trim();
        }
      }

      const raw = JSON.parse(cleaned) as Partial<ClassificationResult>;

      const confidence =
        typeof raw.confidence === 'number' &&
        raw.confidence >= 0 &&
        raw.confidence <= 1
          ? raw.confidence
          : 0.0;

      const category: MessageCategory =
        raw.category && VALID_CATEGORIES.includes(raw.category)
          ? raw.category
          : 'multi_step';

      const complexity: MessageComplexity =
        raw.complexity && VALID_COMPLEXITIES.includes(raw.complexity)
          ? raw.complexity
          : 'medium';

      // Validate suggested_executor — must exist in config or be null
      let suggested_executor: string | null = null;
      if (
        raw.suggested_executor &&
        this.config.executors[raw.suggested_executor] !== undefined
      ) {
        suggested_executor = raw.suggested_executor;
      }

      const needs_orchestrator =
        typeof raw.needs_orchestrator === 'boolean'
          ? raw.needs_orchestrator
          : true;

      const reasoning =
        typeof raw.reasoning === 'string' && raw.reasoning.length > 0
          ? raw.reasoning
          : DEFAULT_CLASSIFICATION.reasoning;

      return {
        complexity,
        category,
        suggested_executor,
        needs_orchestrator,
        confidence,
        reasoning,
      };
    } catch {
      return { ...DEFAULT_CLASSIFICATION };
    }
  }

  /**
   * Build the classifier system prompt.
   * Kept tightly under 800 tokens — no padding, no repetition.
   */
  private buildSystemPrompt(): string {
    return `You are a request classifier. Analyze the user's message and output a JSON classification. Nothing else — no explanation, no markdown, just JSON.

Output schema:
{
  "complexity": "low" | "medium" | "high",
  "category": "conversation" | "code" | "research" | "content" | "ops" | "multi_step",
  "suggested_executor": string | null,
  "needs_orchestrator": boolean,
  "confidence": number (0-1),
  "reasoning": "one sentence"
}

Rules:
- conversation (greetings, thanks, opinions, how are you): complexity low, needs_orchestrator false, suggested_executor null
- Code/programming tasks: category code, suggested_executor "code", needs_orchestrator false
- Search/lookup/fact-finding: category research, suggested_executor "research", needs_orchestrator false
- Writing/drafting/editing: category content, suggested_executor "content", needs_orchestrator false
- Calendar/email/simple ops: category ops, suggested_executor "quick", needs_orchestrator false
- Multi-step or cross-domain (research THEN build/write): category multi_step, needs_orchestrator true, suggested_executor null
- Ambiguous: needs_orchestrator true, confidence low

Examples:
{"complexity":"low","category":"conversation","suggested_executor":null,"needs_orchestrator":false,"confidence":0.95,"reasoning":"Simple greeting"}
{"complexity":"medium","category":"code","suggested_executor":"code","needs_orchestrator":false,"confidence":0.9,"reasoning":"Single code task"}
{"complexity":"medium","category":"research","suggested_executor":"research","needs_orchestrator":false,"confidence":0.85,"reasoning":"Single research task"}
{"complexity":"high","category":"multi_step","suggested_executor":null,"needs_orchestrator":true,"confidence":0.9,"reasoning":"Research then content creation requires orchestration"}`;
  }
}
