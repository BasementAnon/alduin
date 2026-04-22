import { randomBytes } from 'node:crypto';
import { CredentialVault } from '../secrets/vault.js';

export interface OAuthConfig {
  client_id: string;
  client_secret: string;
  auth_endpoint: string;
  token_endpoint: string;
  scopes: string[];
  redirect_uri: string;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  token_type?: string;
}

/**
 * Generic OAuth2 helper.
 * Handles: authorize URL building, state param, code→token exchange, refresh.
 * Callback lands on the webhook gateway at /oauth/:connector_id/callback.
 */
export class OAuthHelper {
  private config: OAuthConfig;
  private vault: CredentialVault;
  private connectorId: string;
  /** In-flight state tokens awaiting callback */
  private pendingStates = new Map<
    string,
    { tenant_id: string; user_id: string; created_at: number }
  >();

  constructor(config: OAuthConfig, vault: CredentialVault, connectorId: string) {
    this.config = config;
    this.vault = vault;
    this.connectorId = connectorId;
  }

  /**
   * Build the authorization URL that the user clicks.
   * Returns { url, state } — state is stored for verification on callback.
   */
  buildAuthorizeUrl(tenantId: string, userId: string): { url: string; state: string } {
    this.sweepExpiredStates();

    const state = randomBytes(16).toString('hex');
    this.pendingStates.set(state, {
      tenant_id: tenantId,
      user_id: userId,
      created_at: Date.now(),
    });

    const params = new URLSearchParams({
      client_id: this.config.client_id,
      redirect_uri: this.config.redirect_uri,
      response_type: 'code',
      scope: this.config.scopes.join(' '),
      state,
      access_type: 'offline',
      prompt: 'consent',
    });

    return { url: `${this.config.auth_endpoint}?${params.toString()}`, state };
  }

  /**
   * Verify a state token from the callback and return the associated context.
   * Consumes the state — it cannot be reused.
   */
  verifyState(state: string): { tenant_id: string; user_id: string } | null {
    this.sweepExpiredStates();

    const pending = this.pendingStates.get(state);
    if (!pending) return null;

    this.pendingStates.delete(state);
    return { tenant_id: pending.tenant_id, user_id: pending.user_id };
  }

  /** Delete all pending states older than 10 minutes */
  private sweepExpiredStates(): void {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [key, entry] of this.pendingStates) {
      if (entry.created_at <= cutoff) {
        this.pendingStates.delete(key);
      }
    }
  }

  /**
   * Exchange an authorization code for tokens and store them in the vault.
   */
  async exchangeCode(
    code: string,
    tenantId: string,
    userId: string
  ): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      code,
      client_id: this.config.client_id,
      client_secret: this.config.client_secret,
      redirect_uri: this.config.redirect_uri,
      grant_type: 'authorization_code',
    });

    let res: Response;
    try {
      res = await fetch(this.config.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error('Token endpoint timeout: authorization code exchange took longer than 15 seconds');
      }
      throw err;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown');
      throw new Error(`Token exchange failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
    };

    const tokens: OAuthTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_type: data.token_type,
      expires_at: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : undefined,
    };

    this.storeTokens(tenantId, userId, tokens);
    return tokens;
  }

  /**
   * Refresh an access token using the stored refresh token.
   */
  async refresh(tenantId: string, userId: string): Promise<OAuthTokens | null> {
    const scope = this.tokenScope(tenantId, userId, 'refresh_token');
    const refreshToken = this.vault.get(scope);
    if (!refreshToken) return null;

    const body = new URLSearchParams({
      client_id: this.config.client_id,
      client_secret: this.config.client_secret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    let res: Response;
    try {
      res = await fetch(this.config.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        console.warn('[OAuth] Token endpoint timeout during refresh');
      }
      return null;
    }

    if (!res.ok) return null;

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const tokens: OAuthTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? refreshToken, // rotate if provided
      expires_at: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : undefined,
    };

    this.storeTokens(tenantId, userId, tokens);
    return tokens;
  }

  /** Get the stored access token for a user, or null. */
  getAccessToken(tenantId: string, userId: string): string | null {
    return this.vault.get(this.tokenScope(tenantId, userId, 'access_token'));
  }

  /** Check if tokens are stored for a user */
  isConnected(tenantId: string, userId: string): boolean {
    return this.vault.has(this.tokenScope(tenantId, userId, 'access_token'));
  }

  /**
   * Persist the access / refresh / expiry triple atomically.
   *
   * H-1: all three rows are written inside a single vault transaction so
   * that a crash between writes cannot leave the user with an access
   * token whose matching refresh token was never stored (or vice versa).
   * Either the whole set is committed or none of it is.
   */
  private storeTokens(tenantId: string, userId: string, tokens: OAuthTokens): void {
    this.vault.transaction(() => {
      this.vault.set(
        this.tokenScope(tenantId, userId, 'access_token'),
        tokens.access_token
      );
      if (tokens.refresh_token) {
        this.vault.set(
          this.tokenScope(tenantId, userId, 'refresh_token'),
          tokens.refresh_token
        );
      }
      if (tokens.expires_at) {
        this.vault.set(
          this.tokenScope(tenantId, userId, 'expires_at'),
          tokens.expires_at
        );
      }
    });
  }

  private tokenScope(tenantId: string, userId: string, key: string): string {
    return `tenants/${tenantId}/users/${userId}/connectors/${this.connectorId}/${key}`;
  }
}
