/**
 * Parse and validate a PORT environment variable value.
 *
 * Rejects any value that is not a string of pure decimal digits (e.g.
 * "3000;evil" is rejected — parseInt would silently return 3000).
 * Also rejects ports outside the valid TCP range 1–65535.
 *
 * Calls `process.exit(1)` (after logging to stderr) on any rejection so
 * callers never receive an unsafe value.
 *
 * @param raw    - The raw string from process.env (or undefined if unset).
 * @param label  - Label used in the error message (e.g. "dev:telegram").
 */
export function parsePort(raw: string | undefined, label = 'alduin'): number {
  const value = raw ?? '3000';

  if (!/^\d+$/.test(value)) {
    process.stderr.write(
      `[${label}] Invalid PORT "${raw ?? ''}" — must be an integer between 1 and 65535. Exiting.\n`
    );
    process.exit(1);
  }

  const port = Number(value);
  if (port < 1 || port > 65535) {
    process.stderr.write(
      `[${label}] Invalid PORT "${raw ?? ''}" — must be an integer between 1 and 65535. Exiting.\n`
    );
    process.exit(1);
  }

  return port;
}
