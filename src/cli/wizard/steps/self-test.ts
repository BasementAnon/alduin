/**
 * Step 8 — Self-test.
 *
 * Runs connectivity and round-trip tests for each configured provider:
 *   - Classifier call: test message, report latency + tokens + cost
 *   - Orchestrator call: simple planning prompt, report latency + tokens + cost
 *   - Telegram: already validated in Step 5 — just confirms status here
 *
 * On failure: offers to go back to the relevant step or continue anyway.
 */

import { confirm, log, spinner } from '@clack/prompts';
import type { ModelCatalog } from '../../../catalog/catalog.js';
import { guard } from '../helpers.js';
import type {
  ChannelAnswers,
  LlmPingResult,
  ModelAnswers,
  ProviderAnswers,
  SelfTestReport,
} from '../types.js';

// ── Formatters (tested) ───────────────────────────────────────────────────────

export function formatSelfTestReport(report: SelfTestReport): string {
  const lines: string[] = [];

  if (report.telegram) {
    const t = report.telegram;
    lines.push(
      t.ok
        ? `  ✓ Telegram      ${t.latencyMs}ms`
        : `  ✗ Telegram      FAILED — ${t.error ?? 'unknown error'}`
    );
  }

  for (const r of report.providerPings) {
    const label = `${r.role} (${r.model})`;
    lines.push(
      r.ok
        ? `  ✓ ${label.padEnd(40)} ${r.latencyMs}ms   ~$${r.estimatedCostUsd.toFixed(6)}`
        : `  ✗ ${label.padEnd(40)} FAILED — ${r.error ?? 'unknown error'}`
    );
  }

  if (lines.length === 0) {
    lines.push('  (no tests run)');
  }

  return lines.join('\n');
}

export function estimatePingCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  catalog: ModelCatalog | null
): number {
  const pricing = catalog?.getPricing(model) ?? { input: 0.00025, output: 0.00125 };
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

// ── Ping helpers ──────────────────────────────────────────────────────────────

const PING_MESSAGES = [
  { role: 'user' as const, content: 'Reply with exactly: ok' },
];
const PING_INPUT_TOKENS = 12;

async function pingAnthropic(
  model: string,
  role: string,
  apiKey: string,
  catalog: ModelCatalog | null
): Promise<LlmPingResult> {
  const apiModel = model.replace(/^anthropic\//, '');
  const start = Date.now();
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: apiModel,
        max_tokens: 10,
        messages: PING_MESSAGES,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      return {
        model, role, ok: false, latencyMs, estimatedCostUsd: 0,
        error: body.error?.message ?? `HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as { usage?: { output_tokens?: number } };
    const outputTokens = data.usage?.output_tokens ?? 5;
    return {
      model, role, ok: true, latencyMs,
      estimatedCostUsd: estimatePingCostUsd(model, PING_INPUT_TOKENS, outputTokens, catalog),
    };
  } catch (e) {
    return {
      model, role, ok: false, latencyMs: Date.now() - start, estimatedCostUsd: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function pingOpenAICompatible(
  model: string,
  role: string,
  apiKey: string,
  baseUrl: string,
  catalog: ModelCatalog | null
): Promise<LlmPingResult> {
  const apiModel = model.replace(/^[\w-]+\//, '');
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: apiModel,
        max_tokens: 10,
        messages: PING_MESSAGES,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      return {
        model, role, ok: false, latencyMs, estimatedCostUsd: 0,
        error: body.error?.message ?? `HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as { usage?: { completion_tokens?: number } };
    const outputTokens = data.usage?.completion_tokens ?? 5;
    return {
      model, role, ok: true, latencyMs,
      estimatedCostUsd: estimatePingCostUsd(model, PING_INPUT_TOKENS, outputTokens, catalog),
    };
  } catch (e) {
    return {
      model, role, ok: false, latencyMs: Date.now() - start, estimatedCostUsd: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function pingOllama(
  model: string,
  role: string,
  baseUrl: string,
  catalog: ModelCatalog | null
): Promise<LlmPingResult> {
  const apiModel = model.replace(/^ollama\//, '');
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: apiModel,
        prompt: 'Reply with exactly: ok',
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return {
        model, role, ok: false, latencyMs, estimatedCostUsd: 0,
        error: `HTTP ${res.status}`,
      };
    }
    return {
      model, role, ok: true, latencyMs,
      estimatedCostUsd: estimatePingCostUsd(model, PING_INPUT_TOKENS, 5, catalog),
    };
  } catch (e) {
    return {
      model, role, ok: false, latencyMs: Date.now() - start, estimatedCostUsd: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function findProviderKey(
  providerId: string,
  providerAnswers: ProviderAnswers
): string | undefined {
  return providerAnswers.providers.find((p) => p.id === providerId)?.apiKey;
}

function findProviderBaseUrl(
  providerId: string,
  providerAnswers: ProviderAnswers
): string | undefined {
  return providerAnswers.providers.find((p) => p.id === providerId)?.baseUrl;
}

async function pingModel(
  model: string,
  role: string,
  providerAnswers: ProviderAnswers,
  catalog: ModelCatalog | null
): Promise<LlmPingResult | null> {
  const provider = model.split('/')[0] ?? '';

  if (provider === 'anthropic') {
    const key = findProviderKey('anthropic', providerAnswers);
    if (!key) return null;
    return pingAnthropic(model, role, key, catalog);
  }
  if (provider === 'openai') {
    const key = findProviderKey('openai', providerAnswers);
    if (!key) return null;
    return pingOpenAICompatible(model, role, key, 'https://api.openai.com/v1', catalog);
  }
  if (provider === 'deepseek') {
    const key = findProviderKey('deepseek', providerAnswers);
    if (!key) return null;
    const base = findProviderBaseUrl('deepseek', providerAnswers) ?? 'https://api.deepseek.com/v1';
    return pingOpenAICompatible(model, role, key, base, catalog);
  }
  if (provider === 'ollama') {
    const base = findProviderBaseUrl('ollama', providerAnswers) ?? 'http://localhost:11434';
    return pingOllama(model, role, base, catalog);
  }
  // OpenAI-compatible custom
  const key = findProviderKey('openai-compatible', providerAnswers) ??
    findProviderKey(provider, providerAnswers);
  const base = findProviderBaseUrl('openai-compatible', providerAnswers) ??
    findProviderBaseUrl(provider, providerAnswers);
  if (!key || !base) return null;
  return pingOpenAICompatible(model, role, key, base, catalog);
}

// ── UI ────────────────────────────────────────────────────────────────────────

export async function runSelfTest(
  modelAnswers: ModelAnswers,
  channelAnswers: ChannelAnswers,
  providerAnswers: ProviderAnswers,
  catalog: ModelCatalog | null
): Promise<SelfTestReport | null> {
  const doTest = guard(
    await confirm({
      message: 'Run a self-test? (LLM round-trip with latency + cost report)',
      initialValue: true,
    })
  );

  if (!doTest) {
    log.info('Skipping self-test. Run `alduin doctor` later to verify your setup.');
    return null;
  }

  const report: SelfTestReport = { providerPings: [] };
  const s = spinner();

  // Telegram status — already validated in Step 5, just report
  if (channelAnswers.channel !== 'cli') {
    if (channelAnswers.botUsername) {
      report.telegram = { ok: true, latencyMs: 0 };
      log.success(`Telegram: already validated as @${channelAnswers.botUsername}`);
    } else if (channelAnswers.botToken) {
      report.telegram = { ok: true, latencyMs: 0 };
      log.info('Telegram: token set (not validated via getMe)');
    }
  }

  // Test unique models across roles
  const a = modelAnswers.assignments;
  const rolesToTest: Array<{ role: string; model: string }> = [
    { role: 'classifier', model: a.classifier },
    { role: 'orchestrator', model: a.orchestrator },
  ];

  // Add other executor models only if they differ
  const seenModels = new Set([a.classifier, a.orchestrator]);
  for (const [role, model] of Object.entries(a)) {
    if (role === 'classifier' || role === 'orchestrator') continue;
    if (!seenModels.has(model)) {
      rolesToTest.push({ role, model });
      seenModels.add(model);
    }
  }

  for (const { role, model } of rolesToTest) {
    s.start(`Testing ${role} model (${model})…`);
    const result = await pingModel(model, role, providerAnswers, catalog);

    if (result) {
      report.providerPings.push(result);
      s.stop(
        result.ok
          ? `${role} ✓ ${result.latencyMs}ms ~$${result.estimatedCostUsd.toFixed(6)}`
          : `${role} ✗ ${result.error ?? 'failed'}`
      );
    } else {
      s.stop(`${role} — skipped (no API key available)`);
    }
  }

  // Summary
  const allPassed = report.providerPings.every((r) => r.ok);
  const telegramOk = !report.telegram || report.telegram.ok;

  if (allPassed && telegramOk) {
    log.success('All self-tests passed.');
  } else {
    const failedCount = report.providerPings.filter((r) => !r.ok).length;
    log.warn(
      `${failedCount} test(s) failed. Run \`alduin doctor\` for detailed diagnostics.`
    );
  }

  return report;
}
