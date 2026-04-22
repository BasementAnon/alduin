/**
 * Secret and PII redactor for memory promotion.
 *
 * Applied when content is promoted from hot memory (short-lived) to warm/cold
 * (persistent). Hot memory retains originals for in-session retrieval; redaction
 * only fires on eviction.
 *
 * Pattern coverage:
 *   - OpenAI API keys       sk-[a-zA-Z0-9]{20,}            → [REDACTED_OPENAI]
 *   - Anthropic API keys    sk-ant-[a-zA-Z0-9_-]{20,}       → [REDACTED_ANTHROPIC]
 *   - GitHub PATs           ghp_[a-zA-Z0-9]{20,}            → [REDACTED_GITHUB]
 *   - JWTs                  eyJ…header.payload.signature    → [REDACTED_JWT]
 *   - AWS access key IDs    AKIA[A-Z0-9]{16}                → [REDACTED_AWS_KEY]
 *
 * Opt-in PII patterns (enabled by config.memory.redact_pii):
 *   - Email addresses   user@example.com                    → [REDACTED_EMAIL]
 *   - Phone numbers     +1-555-123-4567 / (555) 123-4567   → [REDACTED_PHONE]
 *
 * NOTE: These patterns catch common formats; they are not exhaustive. Users
 * should be informed that Alduin memory is persistent and avoid pasting full
 * credentials in chat.
 */

/** Compiled pattern entries — order matters; more specific before less specific */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Anthropic must come before OpenAI (sk-ant- is a sub-prefix of sk-)
  [/sk-ant-[a-zA-Z0-9_-]{20,}/g, '[REDACTED_ANTHROPIC]'],
  [/sk-[a-zA-Z0-9]{20,}/g, '[REDACTED_OPENAI]'],
  [/ghp_[a-zA-Z0-9]{20,}/g, '[REDACTED_GITHUB]'],
  // JWT: three base64url segments separated by dots
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]'],
  [/AKIA[A-Z0-9]{16}/g, '[REDACTED_AWS_KEY]'],
];

const PII_PATTERNS: Array<[RegExp, string]> = [
  // Email addresses
  [/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]'],
  // Phone numbers — common North American and international formats
  [/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/g, '[REDACTED_PHONE]'],
];

/**
 * Redact known secret patterns from text before it enters persistent memory.
 *
 * @param text       - The raw text to sanitise
 * @param redactPii  - When true, also redact emails and phone numbers
 */
export function redactSecrets(text: string, redactPii = false): string {
  let result = text;

  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }

  if (redactPii) {
    for (const [pattern, replacement] of PII_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
  }

  return result;
}
