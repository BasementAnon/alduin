/**
 * Race a promise against a hard deadline.
 *
 * Guarantees the timer handle is always cleared — no handle leaks whether the
 * promise resolves, rejects, or the timeout fires first (B1/B2/B3 fix).
 *
 * @param promise  The work to race against the deadline.
 * @param ms       Milliseconds before the timeout error is thrown.
 * @param message  Optional custom rejection message.
 */
export async function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message = `Timeout after ${ms}ms`,
): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timer]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}
