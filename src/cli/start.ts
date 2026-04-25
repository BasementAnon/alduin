/**
 * alduin start — boots the full two-plane runtime (integration + runtime planes)
 * with the Telegram adapter in long-poll mode and the webhook gateway listening.
 *
 * This is the production entry point. Equivalent to `npm run dev:telegram` but
 * accessible as `alduin start` so operators never need `npm run` directly.
 *
 * Usage:
 *   alduin start [--config config.yaml] [--port 3000]
 *
 * Environment:
 *   PORT                   — HTTP port for the webhook gateway (default 3000)
 *   ALDUIN_BIND_HOST       — Bind address (default 127.0.0.1)
 *   TELEGRAM_BOT_TOKEN     — Bot token (or use token_env in config.yaml)
 *   ANTHROPIC_API_KEY      — Provider key (if using Anthropic)
 */

import { createRuntime } from '../index.js';
import type { AlduinRuntime } from '../index.js';
import { parsePort } from '../util/parse-port.js';

export async function handleStartCommand(
  args: string[],
  configPath: string
): Promise<void> {
  // Parse --port flag if present, otherwise fall back to PORT env / 3000
  let portOverride: number | undefined;
  const portIdx = args.indexOf('--port');
  if (portIdx !== -1 && args[portIdx + 1]) {
    portOverride = parsePort(args[portIdx + 1], 'alduin start');
  }
  const port = portOverride ?? parsePort(process.env['PORT'], 'alduin start');

  console.log(`[alduin start] Booting runtime (config: ${configPath}, port: ${port})…`);

  let runtime: AlduinRuntime;
  try {
    runtime = await createRuntime(configPath);
  } catch (e) {
    console.error(
      `[alduin start] Failed to create runtime: ${e instanceof Error ? e.message : String(e)}`
    );
    process.exit(1);
  }

  try {
    await runtime.start(port);
    console.log('[alduin start] Runtime is live. Press Ctrl+C to shut down.');
  } catch (e) {
    console.error(
      `[alduin start] Failed to start: ${e instanceof Error ? e.message : String(e)}`
    );
    await runtime.stop();
    process.exit(1);
  }

  // Graceful shutdown on SIGINT / SIGTERM
  const shutdown = async (signal: string) => {
    console.log(`\n[alduin start] Received ${signal}, shutting down…`);
    try {
      await runtime.stop();
    } catch (e) {
      console.error(
        `[alduin start] Error during shutdown: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
