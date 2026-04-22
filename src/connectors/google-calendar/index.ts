import type { Connector, ConnectorHealth } from '../framework.js';
import { OAuthHelper } from '../oauth.js';
import { CredentialVault } from '../../secrets/vault.js';
import { buildGoogleCalendarOAuthConfig } from './oauth.config.js';
import { buildGoogleCalendarActions } from './actions.js';

/**
 * Build a fully-wired Google Calendar connector.
 *
 * @param vault       - The credential vault (stores tokens encrypted at rest)
 * @param tenantId    - Tenant isolation scope
 * @param redirectUri - OAuth callback URL (gateway: /oauth/google-calendar/callback)
 */
export function createGoogleCalendarConnector(
  vault: CredentialVault,
  tenantId: string,
  redirectUri: string
): { connector: Connector; oauthHelper: OAuthHelper } {
  const oauthConfig = buildGoogleCalendarOAuthConfig(vault, redirectUri, tenantId);
  const oauthHelper = new OAuthHelper(oauthConfig, vault, 'google-calendar');
  const actions = buildGoogleCalendarActions(oauthHelper);

  const connector: Connector = {
    id: 'google-calendar',
    version: '1.0.0',
    auth: {
      kind: 'oauth2',
      scopes: oauthConfig.scopes,
      refreshToken: async (tid: string, uid: string) => {
        await oauthHelper.refresh(tid, uid);
      },
    },
    actions,
    async health(): Promise<ConnectorHealth> {
      try {
        const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1', {
          headers: { Authorization: 'Bearer dummy' },
          signal: AbortSignal.timeout(5_000),
        });
        // 401 is expected with dummy token — it means the API is reachable
        return res.status === 401 || res.ok
          ? { status: 'ok', latency_ms: 0 }
          : { status: 'degraded', message: `API returned ${res.status}` };
      } catch (e) {
        return {
          status: 'error',
          message: e instanceof Error ? e.message : String(e),
        };
      }
    },
  };

  return { connector, oauthHelper };
}
