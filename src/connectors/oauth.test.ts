import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OAuthHelper } from './oauth.js';
import { CredentialVault } from '../secrets/vault.js';
import type { OAuthConfig } from './oauth.js';

const testConfig: OAuthConfig = {
  client_id: 'test-client-id',
  client_secret: 'test-client-secret',
  auth_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
  scopes: ['read', 'write'],
  redirect_uri: 'https://alduin.example.com/oauth/test/callback',
};

describe('OAuthHelper', () => {
  let vault: CredentialVault;
  let helper: OAuthHelper;

  beforeEach(() => {
    vault = new CredentialVault(':memory:', 'test-secret');
    helper = new OAuthHelper(testConfig, vault, 'test-connector');
  });

  afterEach(() => {
    vault.close();
    vi.unstubAllGlobals();
  });

  describe('buildAuthorizeUrl', () => {
    it('builds a URL with correct query params', () => {
      const { url, state } = helper.buildAuthorizeUrl('tenant-1', 'user-42');
      expect(url).toContain('https://auth.example.com/authorize');
      expect(url).toContain('client_id=test-client-id');
      expect(url).toContain('redirect_uri=');
      expect(url).toContain('response_type=code');
      expect(url).toContain('scope=read+write');
      expect(url).toContain(`state=${state}`);
      expect(url).toContain('access_type=offline');
      expect(state).toBeTruthy();
      expect(state.length).toBe(32); // 16 bytes hex
    });

    it('includes PKCE code_challenge and S256 method', () => {
      const { url } = helper.buildAuthorizeUrl('tenant-1', 'user-42');
      expect(url).toContain('code_challenge_method=S256');
      // code_challenge is base64url sha256(verifier) — 43 chars, no padding
      const match = url.match(/[?&]code_challenge=([A-Za-z0-9_-]+)(?:&|$)/);
      expect(match).not.toBeNull();
      expect(match![1].length).toBe(43);
    });

    it('exchangeCode sends the stored code_verifier back to the token endpoint', async () => {
      const { state } = helper.buildAuthorizeUrl('tenant-1', 'user-42');
      const context = helper.verifyState(state);
      expect(context).not.toBeNull();
      expect(context!.code_verifier).toBeTruthy();

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'at',
          expires_in: 3600,
        }),
      });
      vi.stubGlobal('fetch', fetchSpy);

      await helper.exchangeCode('code', 'tenant-1', 'user-42', context!.code_verifier);

      const body = fetchSpy.mock.calls[0][1].body as string;
      expect(body).toContain(`code_verifier=${encodeURIComponent(context!.code_verifier)}`);
      expect(body).toContain('grant_type=authorization_code');
    });
  });

  describe('verifyState', () => {
    it('verifies a valid state token and returns context', () => {
      const { state } = helper.buildAuthorizeUrl('tenant-1', 'user-42');
      const context = helper.verifyState(state);
      expect(context).not.toBeNull();
      expect(context!.tenant_id).toBe('tenant-1');
      expect(context!.user_id).toBe('user-42');
    });

    it('returns null for an unknown state', () => {
      expect(helper.verifyState('unknown-state')).toBeNull();
    });

    it('consumes the state — cannot be reused', () => {
      const { state } = helper.buildAuthorizeUrl('t', 'u');
      expect(helper.verifyState(state)).not.toBeNull();
      expect(helper.verifyState(state)).toBeNull(); // second attempt fails
    });

    it('sweeps expired states on buildAuthorizeUrl and verifyState', () => {
      // Manually inject an expired state by reaching into the private map
      const internalHelper = helper as unknown as {
        pendingStates: Map<
          string,
          {
            tenant_id: string;
            user_id: string;
            code_verifier: string;
            created_at: number;
          }
        >;
      };

      internalHelper.pendingStates.set('expired-state', {
        tenant_id: 't',
        user_id: 'u',
        code_verifier: 'cv-expired',
        created_at: Date.now() - 11 * 60 * 1000, // 11 minutes ago
      });
      internalHelper.pendingStates.set('fresh-state', {
        tenant_id: 't2',
        user_id: 'u2',
        code_verifier: 'cv-fresh',
        created_at: Date.now(),
      });

      expect(internalHelper.pendingStates.size).toBe(2);

      // buildAuthorizeUrl triggers sweep
      helper.buildAuthorizeUrl('t3', 'u3');

      // Expired state should be gone, fresh + newly-created should remain
      expect(internalHelper.pendingStates.has('expired-state')).toBe(false);
      expect(internalHelper.pendingStates.has('fresh-state')).toBe(true);
      // The state just created by buildAuthorizeUrl
      expect(internalHelper.pendingStates.size).toBe(2);

      // verifyState also sweeps — inject another expired entry
      internalHelper.pendingStates.set('expired-2', {
        tenant_id: 'x',
        user_id: 'y',
        code_verifier: 'cv-2',
        created_at: Date.now() - 15 * 60 * 1000,
      });
      expect(internalHelper.pendingStates.size).toBe(3);

      helper.verifyState('nonexistent'); // triggers sweep
      expect(internalHelper.pendingStates.has('expired-2')).toBe(false);
    });
  });

  describe('exchangeCode', () => {
    it('exchanges code for tokens and stores them in the vault', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            access_token: 'at-new',
            refresh_token: 'rt-new',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        })
      );

      const tokens = await helper.exchangeCode('auth-code-123', 'tenant-1', 'user-42', 'test-verifier');
      expect(tokens.access_token).toBe('at-new');
      expect(tokens.refresh_token).toBe('rt-new');
      expect(tokens.expires_at).toBeTruthy();

      // Verify tokens are in the vault
      expect(
        vault.get('tenants/tenant-1/users/user-42/connectors/test-connector/access_token')
      ).toBe('at-new');
      expect(
        vault.get('tenants/tenant-1/users/user-42/connectors/test-connector/refresh_token')
      ).toBe('rt-new');
    });

    it('throws on failed exchange', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'bad request' })
      );

      await expect(
        helper.exchangeCode('bad-code', 't', 'u', 'test-verifier')
      ).rejects.toThrow('Token exchange failed');
    });
  });

  describe('refresh', () => {
    it('refreshes tokens using stored refresh_token', async () => {
      // Pre-seed a refresh token
      vault.set(
        'tenants/t1/users/u1/connectors/test-connector/refresh_token',
        'old-rt'
      );
      vault.set(
        'tenants/t1/users/u1/connectors/test-connector/access_token',
        'old-at'
      );

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            access_token: 'refreshed-at',
            refresh_token: 'rotated-rt',
            expires_in: 3600,
          }),
        })
      );

      const tokens = await helper.refresh('t1', 'u1');
      expect(tokens).not.toBeNull();
      expect(tokens!.access_token).toBe('refreshed-at');

      // Vault should have the new tokens
      expect(
        vault.get('tenants/t1/users/u1/connectors/test-connector/access_token')
      ).toBe('refreshed-at');
      // Refresh token was rotated
      expect(
        vault.get('tenants/t1/users/u1/connectors/test-connector/refresh_token')
      ).toBe('rotated-rt');
    });

    it('returns null when no refresh_token is stored', async () => {
      const result = await helper.refresh('t1', 'no-user');
      expect(result).toBeNull();
    });
  });

  it('isConnected returns true when access_token exists', () => {
    expect(helper.isConnected('t', 'u')).toBe(false);
    vault.set('tenants/t/users/u/connectors/test-connector/access_token', 'tok');
    expect(helper.isConnected('t', 'u')).toBe(true);
  });

  describe('token endpoint timeouts', () => {
    it('exchangeCode throws "Token endpoint timeout" on slow endpoint', async () => {
      const timeoutErr = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutErr));

      await expect(
        helper.exchangeCode('code', 't', 'u', 'test-verifier')
      ).rejects.toThrow('Token endpoint timeout');
    });

    it('refresh returns null on slow endpoint', async () => {
      vault.set('tenants/t1/users/u1/connectors/test-connector/refresh_token', 'rt');

      const timeoutErr = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutErr));

      const result = await helper.refresh('t1', 'u1');
      expect(result).toBeNull();
    });

    it('exchangeCode re-throws non-timeout errors', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('DNS failure')));

      await expect(
        helper.exchangeCode('code', 't', 'u', 'test-verifier')
      ).rejects.toThrow('DNS failure');
    });
  });
});
