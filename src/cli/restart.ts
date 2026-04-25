/**
 * alduin restart gateway — tears down and re-creates the full runtime.
 *
 * Useful after config changes: reloads config.yaml, reconnects providers,
 * and re-establishes the Telegram long-poll session — all without manually
 * stopping and re-running `alduin start`.
 *
 * Usage:
 *   alduin restart gateway [--config config.yaml] [--port 3000]
 */

import { createRuntime } from '../index.js';
import type { AlduinRuntime } from '../index.js';
import { parsePort } from '../util/parse-port.js';

export async function handleRestartCommand(
  args: string[],
  configPath: string
): Promise<void> {
  const [sub] = args;

  if (sub !== 'gateway') {
    console.error(`alduin restart: unknown target "${sub ?? ''}"`);
    console.error('Usage: alduin restart gateway [--config config.yaml] [--port 3000]');
    process.exit(1);
  }

  // Parse --port flag if present
  const remainingArgs = args.slice(1);
  let portOverride: number | undefined;
  const portIdx = remainingArgs.indexOf('--port');
  if (portIdx !== -1 && remainingArgs[portIdx + 1]) {
    portOverride = parsePort(remainingArgs[portIdx + 1], 'alduin restart gateway');
  }
  const port = portOverride ?? parsePort(process.env['PORT'], 'alduin restart gateway');

  console.log(`[alduin restart gateway] Reloading runtime (config: ${configPath}, port: ${port})…`);

  let runtime: AlduinRuntime;
  try {
    runtime = await createRuntime(configPath);
  } catch (e) {
    console.error(
      `[alduin restart gateway] Failed to create runtime: ${e instanceof Error ? e.message : String(e)}`
    );
    process.exit(1);
  }

  try {
    await runtime.start(port);
    console.log('[alduin restart gateway] Runtime is live. Press Ctrl+C to shut down.');
  } catch (e) {
    console.error(
      `[alduin restart gateway] Failed to start: ${e instanceof Error ? e.message : String(e)}`
    );
    await runtime.stop();
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[alduin restart gateway] Received ${signal}, shutting down…`);
    try {
      await runtime.stop();
    } catch (e) {
      console.error(
        `[alduin restart gateway] Error during shutdown: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
