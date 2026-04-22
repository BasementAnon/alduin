import { z } from 'zod';

/** Health check result for a connector */
export interface ConnectorHealth {
  status: 'ok' | 'degraded' | 'error';
  latency_ms?: number;
  message?: string;
}

/** An external webhook subscription managed by the connector */
export interface WebhookSubscription {
  id: string;
  url: string;
  events: string[];
  active: boolean;
}

/** A typed action exposed by a connector */
export interface ConnectorAction {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  execute(
    input: unknown,
    context: { tenant_id: string; user_id: string }
  ): Promise<unknown>;
}

/**
 * A connector is an authenticated link to an external service.
 * Skills *use* connectors — they never see raw tokens.
 */
export interface Connector {
  /** Unique identifier, e.g. "google-calendar" */
  id: string;
  version: string;
  auth: {
    kind: 'oauth2' | 'api_key' | 'none';
    scopes?: string[];
    /** Refresh the token (called before action execution if expired) */
    refreshToken?: (tenantId: string, userId: string) => Promise<void>;
  };
  webhooks?: WebhookSubscription[];
  /** Typed action surface — skills call these by name */
  actions: Record<string, ConnectorAction>;
  /** Check whether the external service is reachable */
  health(): Promise<ConnectorHealth>;
}

/**
 * Registry of connector instances, loaded at startup.
 * Skills declare `requires_connectors: ['google-calendar']` and resolve
 * connectors from this registry at invocation time.
 */
export class ConnectorRegistry {
  private connectors = new Map<string, Connector>();

  register(connector: Connector): void {
    this.connectors.set(connector.id, connector);
  }

  get(id: string): Connector | undefined {
    return this.connectors.get(id);
  }

  has(id: string): boolean {
    return this.connectors.has(id);
  }

  list(): string[] {
    return [...this.connectors.keys()];
  }

  /** Execute an action on a connector by id + action name */
  async executeAction(
    connectorId: string,
    actionName: string,
    input: unknown,
    context: { tenant_id: string; user_id: string }
  ): Promise<unknown> {
    const connector = this.connectors.get(connectorId);
    if (!connector) throw new Error(`Connector not found: ${connectorId}`);

    const action = connector.actions[actionName];
    if (!action) throw new Error(`Action "${actionName}" not found on ${connectorId}`);

    // Refresh token if needed
    if (connector.auth.refreshToken) {
      await connector.auth.refreshToken(context.tenant_id, context.user_id);
    }

    // Validate input
    const parsed = action.inputSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(`Input validation failed: ${parsed.error.issues[0]?.message}`);
    }

    return action.execute(parsed.data, context);
  }
}
