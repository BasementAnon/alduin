import { describe, it, expect } from 'vitest';
import { estimatePingCostUsd, formatSelfTestReport } from './self-test.js';
import type { SelfTestReport } from '../types.js';

describe('formatSelfTestReport', () => {
  it('renders an all-passing report', () => {
    const report: SelfTestReport = {
      telegram: { ok: true, latencyMs: 120 },
      classifier: {
        model: 'anthropic/claude-haiku-4',
        role: 'classifier',
        ok: true,
        latencyMs: 340,
        estimatedCostUsd: 0.0000012,
      },
      orchestrator: {
        model: 'anthropic/claude-sonnet-4-6',
        role: 'orchestrator',
        ok: true,
        latencyMs: 820,
        estimatedCostUsd: 0.0000054,
      },
    };
    const text = formatSelfTestReport(report);
    expect(text).toContain('✓');
    expect(text).toContain('Telegram');
    expect(text).toContain('classifier');
    expect(text).toContain('orchestrator');
    expect(text).toContain('120ms');
    expect(text).toContain('340ms');
    expect(text).toContain('820ms');
  });

  it('renders failure lines with error message', () => {
    const report: SelfTestReport = {
      classifier: {
        model: 'anthropic/claude-haiku-4',
        role: 'classifier',
        ok: false,
        latencyMs: 50,
        estimatedCostUsd: 0,
        error: 'Unauthorized',
      },
    };
    const text = formatSelfTestReport(report);
    expect(text).toContain('✗');
    expect(text).toContain('Unauthorized');
  });

  it('renders Telegram failure with error', () => {
    const report: SelfTestReport = {
      telegram: { ok: false, latencyMs: 5000, error: 'chat not found' },
    };
    const text = formatSelfTestReport(report);
    expect(text).toContain('✗');
    expect(text).toContain('chat not found');
  });

  it('renders "(no tests run)" when report is empty', () => {
    const text = formatSelfTestReport({});
    expect(text).toContain('no tests run');
  });

  it('renders only the sections that are present', () => {
    const report: SelfTestReport = {
      orchestrator: {
        model: 'anthropic/claude-sonnet-4-6',
        role: 'orchestrator',
        ok: true,
        latencyMs: 500,
        estimatedCostUsd: 0.000003,
      },
    };
    const text = formatSelfTestReport(report);
    expect(text).not.toContain('Telegram');
    expect(text).not.toContain('classifier');
    expect(text).toContain('orchestrator');
  });
});

describe('estimatePingCostUsd', () => {
  it('returns a non-negative number', () => {
    const cost = estimatePingCostUsd('anthropic/claude-sonnet-4-6', 10, 5, null);
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it('uses fallback pricing when catalog is null', () => {
    const cost = estimatePingCostUsd('any/model', 1_000_000, 0, null);
    // fallback input price is 0.00025 / MTok → $0.00025 for 1M tokens
    expect(cost).toBeCloseTo(0.00025, 5);
  });

  it('scales linearly with token count', () => {
    const cost1 = estimatePingCostUsd('any/model', 100, 0, null);
    const cost2 = estimatePingCostUsd('any/model', 200, 0, null);
    expect(cost2).toBeCloseTo(cost1 * 2, 10);
  });
});
