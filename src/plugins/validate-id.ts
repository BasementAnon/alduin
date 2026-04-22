/**
 * Plugin ID validation.
 *
 * M-16: `/alduin plugins install <id>` (chat admin command) and any
 * future `alduin plugins install` CLI command take a plugin identifier
 * from an operator and eventually hand it to `npm install`. Without
 * validation an admin user could inject shell metacharacters such as
 * `; rm -rf ~` or `$(curl … | sh)`. Even when the command is executed
 * via `execFileSync` (arg-array form, no shell) we want to block
 * arbitrary strings from appearing in instructions, audit log entries,
 * and operator-facing messages.
 *
 * The regex intentionally only accepts:
 *   - lowercase ASCII letters and digits (no case-folding surprises)
 *   - `.`, `_`, `-` (npm-valid separators)
 *   - `/` (scoped package path separator)
 *   - a single optional leading `@` (scope marker)
 * and requires the first meaningful character to be alphanumeric.
 *
 * This matches the npm package-name character set (minus uppercase —
 * npm disallows uppercase in published names) and rejects anything
 * that could be interpreted by a shell, a URL parser, or a path
 * traversal (`..`, backticks, quotes, whitespace, pipes, semicolons).
 */
export const PLUGIN_ID_RE = /^@?[a-z0-9][a-z0-9._\-/]*$/;

/** Upper bound on plugin-id length — npm accepts up to 214 chars. */
export const PLUGIN_ID_MAX_LEN = 214;

export interface ValidatePluginIdOk {
  ok: true;
  id: string;
}
export interface ValidatePluginIdErr {
  ok: false;
  error: string;
}
export type ValidatePluginIdResult = ValidatePluginIdOk | ValidatePluginIdErr;

/**
 * Validate a user-supplied plugin identifier.
 *
 * Returns a {@link ValidatePluginIdResult} rather than throwing so the
 * caller can decide how to surface the rejection (CLI exit, chat
 * reply, audit log entry, etc.).
 */
export function validatePluginId(raw: unknown): ValidatePluginIdResult {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Plugin ID must be a string' };
  }
  const id = raw.trim();
  if (id.length === 0) {
    return { ok: false, error: 'Plugin ID cannot be empty' };
  }
  if (id.length > PLUGIN_ID_MAX_LEN) {
    return {
      ok: false,
      error: `Plugin ID exceeds max length (${PLUGIN_ID_MAX_LEN} chars)`,
    };
  }
  // Reject traversal attempts and doubled separators that are legal
  // per the base regex but semantically suspicious.
  if (id.includes('..')) {
    return { ok: false, error: 'Plugin ID must not contain ".."' };
  }
  if (!PLUGIN_ID_RE.test(id)) {
    return {
      ok: false,
      error:
        'Plugin ID must match /^@?[a-z0-9][a-z0-9._\\-/]*$/ ' +
        '(lowercase alnum, dots, hyphens, underscores, slashes; optional leading @)',
    };
  }
  return { ok: true, id };
}
