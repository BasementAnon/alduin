import Database from 'better-sqlite3';

export type UserRole = 'owner' | 'admin' | 'member' | 'guest';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_roles (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','member','guest')),
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);
`;

/**
 * Role resolver backed by SQLite.
 *
 * - owner: the user who ran `alduin init`
 * - admin: explicitly added via /alduin policy or API
 * - member: anyone who has messaged in a group where the bot is active
 * - guest: DMs from users not on any role table
 */
export class RoleResolver {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(SCHEMA);
  }

  /** Initialise with an already-open database handle */
  static create(db: Database.Database): RoleResolver {
    const resolver = Object.create(RoleResolver.prototype) as RoleResolver;
    resolver.db = db;
    db.exec(SCHEMA);
    return resolver;
  }

  /**
   * Resolve a user's role for a given tenant.
   * Falls back to 'guest' if no explicit role is found and the user is in a DM,
   * or 'member' if they've been seen in a group.
   */
  resolve(tenantId: string, userId: string, isGroup: boolean): UserRole {
    const row = this.db
      .prepare<[string, string], { role: string }>(
        'SELECT role FROM user_roles WHERE tenant_id = ? AND user_id = ?'
      )
      .get(tenantId, userId);

    if (row) return row.role as UserRole;

    // No explicit role — member in groups, guest in DMs
    return isGroup ? 'member' : 'guest';
  }

  /** Set an explicit role for a user */
  setRole(tenantId: string, userId: string, role: UserRole): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO user_roles (tenant_id, user_id, role, assigned_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id, user_id) DO UPDATE
           SET role = excluded.role, assigned_at = excluded.assigned_at`
      )
      .run(tenantId, userId, role, now);
  }

  /** Remove a user's explicit role (reverts them to member/guest) */
  removeRole(tenantId: string, userId: string): void {
    this.db
      .prepare('DELETE FROM user_roles WHERE tenant_id = ? AND user_id = ?')
      .run(tenantId, userId);
  }

  /** List all users with explicit roles for a tenant */
  listRoles(tenantId: string): Array<{ user_id: string; role: UserRole }> {
    return this.db
      .prepare<[string], { user_id: string; role: string }>(
        'SELECT user_id, role FROM user_roles WHERE tenant_id = ?'
      )
      .all(tenantId)
      .map((r) => ({ user_id: r.user_id, role: r.role as UserRole }));
  }

  /** Check if a specific user has owner or admin */
  isPrivileged(tenantId: string, userId: string): boolean {
    const role = this.resolve(tenantId, userId, false);
    return role === 'owner' || role === 'admin';
  }
}
