/** Policy overrides scoped to a session (e.g. per-group budget caps) */
export interface PolicyOverrides {
  max_daily_spend_usd?: number;
  allowed_executors?: string[];
  blocked_executors?: string[];
  user_role?: 'owner' | 'admin' | 'member' | 'guest';
  /** When true, sub-orchestration is disabled for the rest of the session. */
  recursion_disabled?: boolean;
}

/**
 * A session is the durable identity that stitches the integration plane
 * to the runtime plane. It is the foreign key on: orchestrator conversation
 * state, executor task lineage, memory tiers, trace records, and budgets.
 */
export interface Session {
  /** Internal UUID — used as the primary key everywhere */
  session_id: string;
  channel: string;
  /** Channel-native thread identifier (e.g. Telegram chat_id) */
  external_thread_id: string;
  /** All user IDs that have participated in this session */
  external_user_ids: string[];
  /** Set for group sessions — links sub-sessions to their parent */
  group_session_id?: string;
  tenant_id: string;
  created_at: string;
  last_active_at: string;
  policy_overrides?: PolicyOverrides;
}
