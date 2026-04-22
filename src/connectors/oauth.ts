import { createHash, randomBytes } from 'node:crypto';
import { CredentialVault } from '../secrets/vault.js';

/** Maximum number of in-flight authorize states before pruning the oldest. */
const MAX_PENDING_STATES = 100;
/** Pending-state TTL (milliseconds). Matches the sweep cutoff. */
const PENDING_STATE_TTL_MS = 10 * 60 * 1000;

/** Compute an RFC 7636 S256 code_challenge from a verifier. */
function deriveCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

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
  /**
   * In-flight state tokens awaiting callback.
   *
   * Each entry carries the PKCE code_verifier (RFC 7636) that was paired with
   * the state when the authorize URL was built. The verifier never leaves the
   * server — only the SHA-256 hash (code_challenge) is sent to the provider —
   * so an attacker who intercepts the authorization code cannot exchange it
   * for tokens without this map entry.
   */
  private pendingStates = new Map<
    string,
    {
      tenant_id: string;
      user_id: string;
      code_verifier: string;
      created_at: number;
    }
  >();

  constructor(config: OAuthConfig, vault: CredentialVault, connectorId: string) {
    this.config = config;
    this.vault = vault;
    this.connectorId = connectorId;
  }

  /**
   * Build the authorization URL that the user clicks.
   * Returns { url, state } — state + PKCE verifier are stored for verification
   * on callback.
   *
   * A 32-byte random `code_verifier` is generated and its SHA-256 hash is sent
   * to the provider as `code_challenge` (method `S256`). On callback, the
   * verifier itself is included in the token exchange POST body — the
   * provider recomputes the hash and rejects the exchange if it does not
   * match the `code_challenge` it saw at authorize time.
   */
  buildAuthorizeUrl(tenantId: string, userId: string): { url: string; state: string } {
    this.sweepExpiredStates();

    const state = randomBytes(16).toString('hex');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = deriveCodeChallenge(codeVerifier);

    this.pendingStates.set(state, {
      tenant_id: tenantId,
      user_id: userId,
      code_verifier: codeVerifier,
      created_at: Date.now(),
    });

    // Enforce a hard ceiling on the in-memory map so a flood of authorize
    // requests can never pin unbounded memory. The oldest entries win the
    // eviction race — they're closest to TTL anyway.
    this.enforceMapCap();

    const params = new URLSearchParams({
      client_id: this.config.client_id,
      redirect_uri: this.config.redirect_uri,
      response_type: 'code',
      scope: this.config.scopes.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    });

    return { url: `${this.config.auth_endpoint}?${params.toString()}`, state };
  }

  /**
   * Verify a state token from the callback and return the associated context,
   * including the PKCE code_verifier that must be echoed in exchangeCode().
   * Consumes the state — it cannot be reused.
   */
  verifyState(state: string): {
    tenant_id: string;
    user_id: string;
    code_verifier: string;
  } | null {
    this.sweepExpiredStates();

    const pending = this.pendingStates.get(state);
    if (!pending) return null;

    this.pendingStates.delete(state);
    return {
      tenant_id: pending.tenant_id,
      user_id: pending.user_id,
      code_verifier: pending.code_verifier,
    };
  }

  /** Delete all pending states older than PENDING_STATE_TTL_MS. */
  private sweepExpiredStates(): void {
    const cutoff = Date.now() - PENDING_STATE_TTL_MS;
    for (const [key, entry] of this.pendingStates) {
      if (entry.created_at <= cutoff) {
        this.pendingStates.delete(key);
      }
    }
  }

  /**
   * Keep the pendingStates map at or below MAX_PENDING_STATES by evicting the
   * oldest entries first. Map iteration order is insertion order, so the
   * first keys are always the oldest.
   */
  private enforceMapCap(): void {
    while (this.pendingStates.size > MAX_PENDING_STATES) {
      const oldestKey = this.pendingStates.keys().next().value;
      if (oldestKey === undefined) break;
      this.pendingStates.delete(oldestKey);
    }
  }

  /**
   * Exchange an authorization code for tokens and store them in the vault.
   *
   * The PKCE `code_verifier` is required and must match the one returned by
   * {@link verifyState} for the same `state`. The provider recomputes
   * `sha256(code_verifier)` and rejects the exchange if it does not match
   * the `code_challenge` it saw at authorize time — so an attacker who
   * intercepts the authorization code cannot redeem it without also
   * obtaining the verifier from this server's memory.
   */
  async exchangeCode(
    code: string,
    tenantId: string,
    userId: string,
    codeVerifier: string
  ): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      code,
      client_id: this.config.client_id,
      client_secret: this.config.client_secret,
      redirect_uri: this.config.redirect_uri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
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
