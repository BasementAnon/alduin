import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handleConnectCommand,
  handleOAuthCallback,
  isCommand,
} from './connect.js';
import { ConnectorRegistry } from '../../connectors/framework.js';
import { OAuthHelper } from '../../connectors/oauth.js';
import { CredentialVault } from '../../secrets/vault.js';
import type { NormalizedEvent } from '../adapter.js';
import type { Session } from '../../session/types.js';

function makeEvent(text: string): NormalizedEvent {
  return {
    event_id: 'e1',
    channel: 'telegram',
    received_at: new Date().toISOString(),
    external: {
      thread_id: 'chat-1',
      user_id: 'user-42',
      is_group: false,
      message_id: '1',
    },
    kind: 'message',
    text,
    raw: {},
  };
}

const session: Session = {
  session_id: 'sess-1',
  channel: 'telegram',
  external_thread_id: 'chat-1',
  external_user_ids: ['user-42'],
  tenant_id: 'acme',
  created_at: new Date().toISOString(),
  last_active_at: new Date().toISOString(),
};

describe('connect command', () => {
  let vault: CredentialVault;
  let registry: ConnectorRegistry;
  let helpers: Map<string, OAuthHelper>;

  beforeEach(() => {
    vault = new CredentialVault(':memory:', 'test');
    registry = new ConnectorRegistry();
    helpers = new Map();

    // Register a dummy connector with an OAuth helper
    registry.register({
      id: 'google-calendar',
      version: '1.0.0',
      auth: { kind: 'oauth2', scopes: ['calendar'] },
      actions: {},
      async health() { return { status: 'ok' }; },
    });

    helpers.set(
      'google-calendar',
      new OAuthHelper(
        {
          client_id: 'cid',
          client_secret: 'csec',
          auth_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          scopes: ['calendar'],
          redirect_uri: 'https://alduin.example.com/oauth/google-calendar/callback',
        },
        vault,
        'google-calendar'
      )
    );
  });

  afterEach(() => {
    vault.close();
    vi.unstubAllGlobals();
  });

  it('ignores non-/connect messages', () => {
    const result = handleConnectCommand(
      makeEvent('Hello world'),
      session,
      registry,
      helpers
    );
    expect(result.handled).toBe(false);
  });

  it('shows help when /connect is sent without a connector name', () => {
    const result = handleConnectCommand(
      makeEvent('/connect'),
      session,
      registry,
      helpers
    );
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('google-calendar');
  });

  it('returns an error for an unknown connector', () => {
    const result = handleConnectCommand(
      makeEvent('/connect github'),
      session,
      registry,
      helpers
    );
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('Unknown connector');
  });

  it('returns an OAuth URL for a valid connector', () => {
    const result = handleConnectCommand(
      makeEvent('/connect google-calendar'),
      session,
      registry,
      helpers
    );
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('https://auth.example.com/authorize');
    expect(result.reply).toContain('10 minutes');
  });

  it('says already connected when tokens exist', () => {
    vault.set(
      'tenants/acme/users/user-42/connectors/google-calendar/access_token',
      'existing-token'
    );
    const result = handleConnectCommand(
      makeEvent('/connect google-calendar'),
      session,
      registry,
      helpers
    );
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('already connected');
  });

  describe('handleOAuthCallback', () => {
    it('exchanges code and stores tokens in vault on valid callback', async () => {
      // Get a valid state by initiating the connect flow
      const connectResult = handleConnectCommand(
        makeEvent('/connect google-calendar'),
        session,
        registry,
        helpers
      );
      // Extract state from the URL
      const url = new URL(connectResult.reply!.match(/https:\/\/[^\s]+/)![0]);
      const state = url.searchParams.get('state')!;

      // Mock the token exchange
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'new-at',
          refresh_token: 'new-rt',
          expires_in: 3600,
        }),
      }));

      const result = await handleOAuthCallback(
        'google-calendar',
        'auth-code-xyz',
        state,
        helpers
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Successfully connected');
      expect(result.tenant_id).toBe('acme');
      expect(result.user_id).toBe('user-42');

      // Verify vault has the tokens
      expect(
        vault.get('tenants/acme/users/user-42/connectors/google-calendar/access_token')
      ).toBe('new-at');
    });

    it('rejects an invalid state', async () => {
      const result = await handleOAuthCallback(
        'google-calendar',
        'some-code',
        'bad-state',
        helpers
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid or expired');
    });

    it('returns error for an unknown connector', async () => {
      const result = await handleOAuthCallback('unknown', 'code', 'state', helpers);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unknown connector');
    });
  });

  describe('isCommand', () => {
    it('returns true for strings starting with /', () => {
      expect(isCommand('/connect')).toBe(true);
      expect(isCommand('/help')).toBe(true);
      expect(isCommand(' /padded')).toBe(true);
    });

    it('returns false for normal text', () => {
      expect(isCommand('hello')).toBe(false);
      expect(isCommand('')).toBe(false);
      expect(isCommand(undefined)).toBe(false);
    });
  });
});
