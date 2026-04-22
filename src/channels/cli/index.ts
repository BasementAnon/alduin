import readline from 'node:readline';
import { v4 as uuidv4 } from 'uuid';
import type {
  ChannelAdapter,
  ChannelCapabilities,
  PresentationPayload,
  ChannelTarget,
  SentMessageRef,
  RawChannelEvent,
} from '../adapter.js';

const CLI_CAPABILITIES: ChannelCapabilities = {
  supports_edit: false,
  supports_buttons: false,
  supports_threads: false,
  supports_files: false,
  supports_voice: false,
  supports_typing_indicator: false,
  max_message_length: 100_000,
  max_attachment_bytes: 0,
  markdown_dialect: 'plain',
};

/**
 * CLI channel adapter.
 * Wraps the readline-based REPL so it conforms to ChannelAdapter.
 * The existing src/cli.ts REPL continues to work — this adapter is the
 * integration-plane-aware version that emits RawChannelEvents.
 */
export class CliAdapter implements ChannelAdapter {
  readonly id = 'cli';
  readonly capabilities: ChannelCapabilities = CLI_CAPABILITIES;

  private rl: readline.Interface | null = null;
  private eventHandler: ((event: RawChannelEvent) => void) | null = null;
  private userId: string;
  private threadId: string;

  constructor(options: { user_id?: string; thread_id?: string } = {}) {
    this.userId = options.user_id ?? 'cli-user';
    this.threadId = options.thread_id ?? 'cli-session';
  }

  onEvent(handler: (event: RawChannelEvent) => void): void {
    this.eventHandler = handler;
  }

  async start(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'you> ',
    });

    this.rl.prompt();

    this.rl.on('line', (input) => {
      const line = input.trim();
      if (!line) {
        this.rl?.prompt();
        return;
      }
      if (!this.eventHandler) {
        this.rl?.prompt();
        return;
      }
      const event: RawChannelEvent = {
        channel: 'cli',
        received_at: new Date().toISOString(),
        payload: {
          user_id: this.userId,
          thread_id: this.threadId,
          text: line,
          message_id: uuidv4(),
        },
      };
      this.eventHandler(event);
    });

    this.rl.on('close', () => {
      process.exit(0);
    });
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = null;
  }

  async send(
    payload: PresentationPayload,
    _target: ChannelTarget
  ): Promise<SentMessageRef> {
    console.log(`\nalduin> ${payload.text}\n`);
    this.rl?.prompt();
    return {
      message_id: uuidv4(),
      channel: 'cli',
      thread_id: this.threadId,
    };
  }

  async edit(_ref: SentMessageRef, payload: PresentationPayload): Promise<void> {
    // CLI doesn't support edits — re-print
    console.log(`\n[updated] ${payload.text}\n`);
    this.rl?.prompt();
  }

  /**
   * CLI has no network transport — it is never reachable via the webhook
   * gateway, so signature verification is a no-op that always succeeds.
   */
  verifyWebhookSignature(
    _headers: Record<string, string | string[] | undefined>,
    _body?: Buffer,
  ): boolean {
    return true;
  }

  /** Prompt the user again (called after a response is sent) */
  reprompt(): void {
    this.rl?.prompt();
  }
}
