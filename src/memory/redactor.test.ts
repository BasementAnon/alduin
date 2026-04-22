import { describe, it, expect } from 'vitest';
import { redactSecrets } from './redactor.js';

describe('redactSecrets', () => {
  it('redacts OpenAI API keys (sk-...)', () => {
    const input = 'My OpenAI key is sk-abcdefghijklmnopqrstuvwxyz123456 — use it wisely';
    const result = redactSecrets(input);
    expect(result).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(result).toContain('[REDACTED_OPENAI]');
  });

  it('redacts Anthropic API keys (sk-ant-...)', () => {
    const input = 'Anthropic key: sk-ant-api03-ABCdefGHIjklMNOpqrSTU_v-VWXYZabcde';
    const result = redactSecrets(input);
    expect(result).not.toContain('sk-ant');
    expect(result).toContain('[REDACTED_ANTHROPIC]');
    // Must NOT produce [REDACTED_OPENAI] for sk-ant- keys
    expect(result).not.toContain('[REDACTED_OPENAI]');
  });

  it('redacts GitHub PATs (ghp_...)', () => {
    const input = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234 is my token';
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED_GITHUB]');
    expect(result).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234');
  });

  it('redacts JWTs (eyJ...header.payload.signature)', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const input = `Bearer ${jwt}`;
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED_JWT]');
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('redacts AWS access key IDs (AKIA...)', () => {
    const input = 'AWS key: AKIAIOSFODNN7EXAMPLE used in prod';
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED_AWS_KEY]');
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('leaves normal text untouched', () => {
    const input = 'Hello, I need help with Python lists.';
    expect(redactSecrets(input)).toBe(input);
  });

  it('handles multiple secrets in one string', () => {
    const input = 'key1=sk-aaaaaaaaaaaaaaaaaaaaa key2=AKIAIOSFODNN7EXAMPLE';
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED_OPENAI]');
    expect(result).toContain('[REDACTED_AWS_KEY]');
    expect(result).not.toContain('sk-aaaaaaaaaaaaaaaaaaaaa');
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('does NOT redact emails or phones when redactPii=false (default)', () => {
    const input = 'Email me at alice@example.com or call 555-123-4567';
    const result = redactSecrets(input);
    expect(result).toContain('alice@example.com');
    expect(result).toContain('555-123-4567');
  });

  it('redacts emails when redactPii=true', () => {
    const input = 'Contact: alice@example.com';
    const result = redactSecrets(input, true);
    expect(result).toContain('[REDACTED_EMAIL]');
    expect(result).not.toContain('alice@example.com');
  });

  it('redacts phone numbers when redactPii=true', () => {
    const input = 'Call +1-555-123-4567 or (555) 987-6543';
    const result = redactSecrets(input, true);
    expect(result).toContain('[REDACTED_PHONE]');
    expect(result).not.toContain('555-123-4567');
  });

  // ── S5: New pattern coverage ──────────────────────────────────────────────

  it('redacts Slack bot tokens (xoxb-...)', () => {
    const input = 'slack_token=xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOp';
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED_SLACK]');
    expect(result).not.toContain('xoxb-');
  });

  it('redacts Slack user tokens (xoxp-...)', () => {
    const input = 'Authorization: xoxp-9876543210-9876543210987-abcdefghijklmnop';
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED_SLACK]');
  });

  it('redacts Google API keys (AIza...)', () => {
    const input = 'const apiKey = "AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI";';
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED_GOOGLE_API]');
    expect(result).not.toContain('AIzaSy');
  });

  it('redacts Stripe live secret keys (sk_live_...)', () => {
    const input = 'stripe.setApiKey("sk_live_ABCDEFGHIJKLMNOPQRSTUVWXyz")';
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED_STRIPE]');
    expect(result).not.toContain('sk_live_');
  });

  it('redacts Stripe live restricted keys (rk_live_...)', () => {
    const input = 'key = rk_live_ABCDEFGHIJKLMNOPQRSTUVWXyz';
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED_STRIPE]');
    expect(result).not.toContain('rk_live_');
  });

  it('redacts Bearer tokens in Authorization headers', () => {
    const input = 'Authorization: Bearer eyABC123.def456.ghi789';
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED_BEARER]');
    expect(result).not.toContain('eyABC123');
  });

  it('redacts Telegram bot tokens', () => {
    // Real Telegram bot tokens: {8-10 digits}:{35 alphanumeric/underscore/dash chars}
    const input = 'bot token: 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED_TELEGRAM_BOT]');
    expect(result).not.toContain('123456789:');
  });

  it('redacts GitHub fine-grained PATs (github_pat_...)', () => {
    const input = 'token: github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED_GITHUB_FINEGRAINED]');
    expect(result).not.toContain('github_pat_');
    // Must not also fire the generic ghp_ pattern
    expect(result).not.toContain('[REDACTED_GITHUB]');
  });

  it('redacts PEM private keys', () => {
    const input = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED_PRIVATE_KEY]');
    expect(result).not.toContain('MIIEowIBAAKCAQEA');
  });

  it('redacts generic OPENSSH private keys', () => {
    const input = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAA=',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED_PRIVATE_KEY]');
  });
});
