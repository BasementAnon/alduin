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
});
