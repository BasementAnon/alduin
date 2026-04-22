import type { NormalizedEvent } from '../adapter.js';
import type { Session } from '../../session/types.js';
import type { OAuthHelper } from '../../connectors/oauth.js';
import type { ConnectorRegistry } from '../../connectors/framework.js';

/** Result of handling a /connect command */
export interface ConnectCommandResult {
  handled: boolean;
  reply?: string;
}

/**
 * Handle `/connect <connector_id>` commands.
 *
 * Flow: user types `/connect google-calendar` → bot DMs a one-time OAuth URL →
 * user completes → callback stores tokens in vault → bot confirms.
 *
 * Commands are parsed from NormalizedEvent.text before the pre-classifier
 * sees the message, so they bypass the orchestrator entirely.
 */
export function handleConnectCommand(
  event: NormalizedEvent,
  session: Session,
  connectorRegistry: ConnectorRegistry,
  oauthHelpers: Map<string, OAuthHelper>
): ConnectCommandResult {
  const text = (event.text ?? '').trim();

  if (!text.startsWith('/connect')) {
    return { handled: false };
  }

  const parts = text.split(/\s+/);
  const connectorId = parts[1];

  if (!connectorId) {
    const available = connectorRegistry.list();
    return {
      handled: true,
      reply:
        available.length > 0
          ? `Usage: /connect <connector>\nAvailable: ${available.join(', ')}`
          : 'No connectors configured.',
    };
  }

  if (!connectorRegistry.has(connectorId)) {
    return {
      handled: true,
      reply: `Unknown connector: ${connectorId}\nAvailable: ${connectorRegistry.list().join(', ')}`,
    };
  }

  const oauthHelper = oauthHelpers.get(connectorId);
  if (!oauthHelper) {
    return {
      handled: true,
      reply: `Connector "${connectorId}" does not use OAuth2.`,
    };
  }

  // Check if already connected
  if (oauthHelper.isConnected(session.tenant_id, event.external.user_id)) {
    return {
      handled: true,
      reply: `You're already connected to ${connectorId}. Use /disconnect ${connectorId} to re-link.`,
    };
  }

  // Build OAuth URL
  const { url } = oauthHelper.buildAuthorizeUrl(
    session.tenant_id,
    event.external.user_id
  );

  return {
    handled: true,
    reply: `🔗 Click here to connect ${connectorId}:\n${url}\n\nThis link expires in 10 minutes.`,
  };
}

/**
 * Handle the OAuth callback after the user completes authorization.
 * Called from the webhook gateway at /oauth/:connector_id/callback.
 *
 * @returns A user-facing confirmation message, or an error string.
 */
export async function handleOAuthCallback(
  connectorId: string,
  code: string,
  state: string,
  oauthHelpers: Map<string, OAuthHelper>
): Promise<{ success: boolean; message: string; tenant_id?: string; user_id?: string }> {
  const helper = oauthHelpers.get(connectorId);
  if (!helper) {
    return { success: false, message: `Unknown connector: ${connectorId}` };
  }

  const context = helper.verifyState(state);
  if (!context) {
    return { success: false, message: 'Invalid or expired authorization state.' };
  }

  try {
    await helper.exchangeCode(code, context.tenant_id, context.user_id);
    return {
      success: true,
      message: `✅ Successfully connected to ${connectorId}!`,
      tenant_id: context.tenant_id,
      user_id: context.user_id,
    };
  } catch (err) {
    return {
      success: false,
      message: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Check if a message is a command (starts with /) */
export function isCommand(text: string | undefined): boolean {
  return !!text && text.trimStart().startsWith('/');
}
