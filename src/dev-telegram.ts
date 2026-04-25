#!/usr/bin/env node
/**
 * alduin dev:telegram — boots just the integration + runtime planes with a Telegram adapter
 * and logs received NormalizedEvents + Sessions to stdout.
 *
 * Usage:
 *   npx tsx src/dev-telegram.ts [--config config.yaml]
 *   (secrets are loaded from .env automatically; TELEGRAM_BOT_TOKEN can also be
 *    passed inline as an env var override)
 */

// Load .env before reading any env vars (token, API keys, etc.)
import 'dotenv/config';

import { parseArgs } from 'node:util';
import { createRuntime } from './index.js';
import { parsePort } from './util/parse-port.js';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { config: { type: 'string', short: 'c', default: './config.yaml' } },
  strict: false,
});

const configPath = typeof values.config === 'string' ? values.config : './config.yaml';
const PORT = parsePort(process.env['PORT'], 'dev:telegram');

console.log(`[dev:telegram] Starting with config: ${configPath}`);

const runtime = await createRuntime(configPath, { dbPath: ':memory:' });
await runtime.start(PORT);

process.on('SIGINT', async () => {
  console.log('\n[dev:telegram] Shutting down…');
  await runtime.stop();
  process.exit(0);
});
