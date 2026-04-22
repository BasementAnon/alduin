import { confirm, log, spinner, text } from '@clack/prompts';
import type { ModelCatalog } from '../../../catalog/catalog.js';
import type { CredentialVault } from '../../../secrets/vault.js';
import { guard } from '../helpers.js';
import type {
  LlmPingResult,
  ModelAnswers,
  SelfTestReport,
  TelegramPingResult,
} from '../types.js';

// ── Formatters (tested) ───────────────────────────────────────────────────────

/**
 * Render a self-test report as human-readable lines.
 * Input is pure data so the formatter is deterministic and testable.
 */
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

  for (const role of ['classifier', 'orchestrator'] as const) {
    const r = report[role];
    if (r) {
      lines.push(
        r.ok
          ? `  ✓ ${role.padEnd(13)} ${r.latencyMs}ms   ~$${r.estimatedCostUsd.toFixed(6)}`
          : `  ✗ ${role.padEnd(13)} FAILED — ${r.error ?? 'unknown error'}`
      );
    }
  }

  if (lines.length === 0) {
    lines.push('  (no tests run)');
  }

  return lines.join('\n');
}

/**
 * Estimate the cost of a single API round-trip.
 * Uses catalog pricing when available; falls back to Anthropic Haiku rates.
 */
export function estimatePingCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  catalog: ModelCatalog | null
): number {
  const pricing = catalog?.getPricing(model) ?? { input: 0.00025, output: 0.00125 };
  // Pricing is per million tokens in the catalog
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

// ── Ping helpers ──────────────────────────────────────────────────────────────

/** Minimal system + user message for the ping. */
const PING_MESSAGES = [
  { role: 'user' as const, content: 'Reply with exactly: ok' },
];
const PING_INPUT_TOKENS = 12; // conservative estimate

async function pingAnthropic(
  model: string,
  role: 'classifier' | 'orchestrator',
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
        model,
        role,
        ok: false,
        latencyMs,
        estimatedCostUsd: 0,
        error: body.error?.message ?? `HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as { usage?: { output_tokens?: number } };
    const outputTokens = data.usage?.output_tokens ?? 5;
    return {
      model,
      role,
      ok: true,
      latencyMs,
      estimatedCostUsd: estimatePingCostUsd(model, PING_INPUT_TOKENS, outputTokens, catalog),
    };
  } catch (e) {
    return {
      model,
      role,
      ok: false,
      latencyMs: Date.now() - start,
      estimatedCostUsd: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function pingOpenAI(
  model: string,
  role: 'classifier' | 'orchestrator',
  apiKey: string,
  catalog: ModelCatalog | null
): Promise<LlmPingResult> {
  const apiModel = model.replace(/^openai\//, '');
  const start = Date.now();
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
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
        model,
        role,
        ok: false,
        latencyMs,
        estimatedCostUsd: 0,
        error: body.error?.message ?? `HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as {
      usage?: { completion_tokens?: number };
    };
    const outputTokens = data.usage?.completion_tokens ?? 5;
    return {
      model,
      role,
      ok: true,
      latencyMs,
      estimatedCostUsd: estimatePingCostUsd(model, PING_INPUT_TOKENS, outputTokens, catalog),
    };
  } catch (e) {
    return {
      model,
      role,
      ok: false,
      latencyMs: Date.now() - start,
      estimatedCostUsd: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Ping a single model. Returns null if no API key is available.
 * Only Anthropic and OpenAI are supported; local (Ollama) models are skipped.
 */
async function pingModel(
  model: string,
  role: 'classifier' | 'orchestrator',
  catalog: ModelCatalog | null
): Promise<LlmPingResult | null> {
  if (model.startsWith('anthropic/')) {
    const key = process.env['ANTHROPIC_API_KEY'];
    if (!key) return null;
    return pingAnthropic(model, role, key, catalog);
  }
  if (model.startsWith('openai/')) {
    const key = process.env['OPENAI_API_KEY'];
    if (!key) return null;
    return pingOpenAI(model, role, key, catalog);
  }
  // Ollama / DeepSeek / others — skip during wizard self-test
  return null;
}

/**
 * Test Telegram connectivity by sending a /start-like message to a chat.
 */
async function pingTelegram(
  botToken: string,
  chatId: string
): Promise<TelegramPingResult> {
  const start = Date.now();
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: '✅ Alduin is configured! This message confirms Telegram connectivity.',
        }),
        signal: AbortSignal.timeout(15_000),
      }
    );
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { description?: string };
      return { ok: false, latencyMs, error: body.description ?? `HTTP ${res.status}` };
    }
    return { ok: true, latencyMs };
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── UI (not tested directly) ──────────────────────────────────────────────────

/**
 * Step 5 — optional self-test: Telegram ping + one classifier + one orchestrator
 * LLM round-trip. Reports latency and estimated cost.
 * Throws WizardCancelledError on Ctrl-C.
 */
export async function runSelfTest(
  vault: CredentialVault,
  models: ModelAnswers,
  channel: string,
  catalog: ModelCatalog | null
): Promise<SelfTestReport | null> {
  const doTest = guard(
    await confirm({
      message: 'Run a self-test? (Telegram ping + LLM round-trip with latency + cost report)',
      initialValue: true,
    })
  );

  if (!doTest) {
    log.info('Skipping self-test. Run `alduin doctor` later to verify your setup.');
    return null;
  }

  const report: SelfTestReport = {};
  const s = spinner();

  // ── Telegram test ────────────────────────────────────────────────────────────
  if (channel === 'telegram') {
    const token = vault.get('channels/telegram/bot_token');
    if (token) {
      const rawChatId = guard(
        await text({
          message: 'Your Telegram chat ID (from @userinfobot or /start on your bot):',
          placeholder: '123456789',
          validate: (v) => (v && /^\d+$/.test(v.trim()) ? undefined : 'Must be a numeric chat ID'),
        })
      );

      s.start('Pinging Telegram…');
      report.telegram = await pingTelegram(token, rawChatId.trim());
      s.stop(report.telegram.ok ? 'Telegram ✓' : 'Telegram ✗');
    } else {
      log.warn('Bot token not found in vault — skipping Telegram ping.');
    }
  }

  // ── LLM tests ────────────────────────────────────────────────────────────────
  s.start(`Pinging classifier model (${models.classifierModel})…`);
  const classifierResult = await pingModel(models.classifierModel, 'classifier', catalog);
  if (classifierResult) {
    report.classifier = classifierResult;
    s.stop(
      classifierResult.ok
        ? `Classifier ✓ ${classifierResult.latencyMs}ms`
        : `Classifier ✗ ${classifierResult.error}`
    );
  } else {
    s.stop('Classifier — skipped (no API key in environment)');
  }

  s.start(`Pinging orchestrator model (${models.orchestratorModel})…`);
  const orchestratorResult = await pingModel(models.orchestratorModel, 'orchestrator', catalog);
  if (orchestratorResult) {
    report.orchestrator = orchestratorResult;
    s.stop(
      orchestratorResult.ok
        ? `Orchestrator ✓ ${orchestratorResult.latencyMs}ms`
        : `Orchestrator ✗ ${orchestratorResult.error}`
    );
  } else {
    s.stop('Orchestrator — skipped (no API key in environment)');
  }

  return report;
}
