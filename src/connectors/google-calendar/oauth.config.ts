import type { OAuthConfig } from '../oauth.js';
import type { CredentialVault } from '../../secrets/vault.js';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

/**
 * Build the Google Calendar OAuth config.
 * Client ID and secret are loaded from the vault — never from env or YAML.
 */
export function buildGoogleCalendarOAuthConfig(
  vault: CredentialVault,
  redirectUri: string,
  tenantId: string
): OAuthConfig {
  const clientId =
    vault.get(`tenants/${tenantId}/connectors/google-calendar/client_id`) ?? '';
  const clientSecret =
    vault.get(`tenants/${tenantId}/connectors/google-calendar/client_secret`) ?? '';

  return {
    client_id: clientId,
    client_secret: clientSecret,
    auth_endpoint: GOOGLE_AUTH_ENDPOINT,
    token_endpoint: GOOGLE_TOKEN_ENDPOINT,
    scopes: SCOPES,
    redirect_uri: redirectUri,
  };
}

/** Pre-seed client credentials into the vault for a tenant */
export function seedGoogleCredentials(
  vault: CredentialVault,
  tenantId: string,
  clientId: string,
  clientSecret: string
): void {
  vault.set(`tenants/${tenantId}/connectors/google-calendar/client_id`, clientId);
  vault.set(`tenants/${tenantId}/connectors/google-calendar/client_secret`, clientSecret);
}
