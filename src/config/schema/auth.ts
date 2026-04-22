import { z } from 'zod';

/**
 * Authentication / authorization policy configuration.
 *
 * Currently scoped to the privileged-role bypass behaviour. More auth-layer
 * knobs (e.g. token rotation policies, session TTLs) will land here over time.
 */
export const authConfigSchema = z.object({
  /**
   * When true, owner/admin roles bypass ALL policy rules — including
   * cost_ceiling_usd and budget caps. This is the legacy behaviour.
   *
   * When false (the default), owner/admin roles still bypass allowlist /
   * denylist rules and tier restrictions, but rules that set
   * `cost_ceiling_usd` are always applied. This protects against compromised
   * privileged tokens from draining the budget.
   */
  privileged_bypass_budgets: z.boolean().default(false),
}).strict();

/** Auth policy configuration. */
export type AuthConfig = z.output<typeof authConfigSchema>;
