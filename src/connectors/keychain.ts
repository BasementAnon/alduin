/**
 * OS keychain abstraction for storing the vault master secret.
 *
 * In production, this wraps `keytar` (macOS Keychain / libsecret / DPAPI).
 * keytar is an optional native dependency — if not installed, falls back to
 * an environment variable (ALDUIN_VAULT_SECRET).
 *
 * The keychain stores ONLY the encryption key. All actual credentials live in
 * the encrypted SQLite vault file.
 */

const SERVICE_NAME = 'alduin-orchestrator';
const ACCOUNT_NAME = 'vault-master-key';
const AUDIT_ACCOUNT = 'audit-hmac-key';

export interface KeychainProvider {
  getMasterSecret(): Promise<string>;
  setMasterSecret(secret: string): Promise<void>;
  getAuditHmacKey(): Promise<string>;
  setAuditHmacKey(key: string): Promise<void>;
}

/**
 * Production keychain provider.
 * Tries keytar → env var. Refuses to silently generate a one-shot key.
 *
 * For first-run, call `generateAndStore()` explicitly (the init wizard does this).
 */
export class OSKeychain implements KeychainProvider {
  async getMasterSecret(): Promise<string> {
    // Try keytar first
    const keytarSecret = await this.tryKeytar('get');
    if (keytarSecret) return keytarSecret;

    // Fallback to env var
    const envSecret = process.env['ALDUIN_VAULT_SECRET'];
    if (envSecret) return envSecret;

    throw new Error(
      'Cannot obtain vault master secret. ' +
      'Install keytar (npm i keytar) or set ALDUIN_VAULT_SECRET env var.\n\n' +
      'To generate a secret: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  /**
   * Generate a new master secret and persist it.
   * Called by `alduin init` — never called implicitly.
   * Tries keytar first; if unavailable, throws with instructions.
   */
  async generateAndStore(): Promise<string> {
    const { randomBytes } = await import('node:crypto');
    const newSecret = randomBytes(32).toString('hex');

    const stored = await this.tryKeytar('set', newSecret);
    if (stored) return newSecret;

    throw new Error(
      'Cannot store master secret: keytar is not installed and ALDUIN_VAULT_SECRET is not set.\n' +
      'Either:\n' +
      '  • npm install keytar\n' +
      '  • Set ALDUIN_VAULT_SECRET in your .env file to a random 64-char hex string.'
    );
  }

  async setMasterSecret(secret: string): Promise<void> {
    const stored = await this.tryKeytar('set', secret);
    if (!stored) {
      console.warn(
        '[Keychain] keytar not available — set ALDUIN_VAULT_SECRET env var instead'
      );
    }
  }

  /**
   * Retrieve the audit HMAC key.
   * Tries keytar (AUDIT_ACCOUNT) → ALDUIN_AUDIT_HMAC_KEY env var → throws.
   */
  async getAuditHmacKey(): Promise<string> {
    const keytarKey = await this.tryKeytarAccount('get', AUDIT_ACCOUNT);
    if (keytarKey) return keytarKey;

    const envKey = process.env['ALDUIN_AUDIT_HMAC_KEY'];
    if (envKey) return envKey;

    throw new Error(
      'Cannot obtain audit HMAC key. ' +
      'Install keytar (npm i keytar) or set ALDUIN_AUDIT_HMAC_KEY env var.'
    );
  }

  /**
   * Store the audit HMAC key.
   * Tries keytar first; if unavailable, throws (do not silently discard).
   */
  async setAuditHmacKey(key: string): Promise<void> {
    const stored = await this.tryKeytarAccount('set', AUDIT_ACCOUNT, key);
    if (!stored) {
      throw new Error(
        'Cannot persist audit HMAC key: keytar is not installed.\n' +
        'Set ALDUIN_AUDIT_HMAC_KEY in your .env file instead.'
      );
    }
  }

  /**
   * Generate a new audit HMAC key and persist it.
   * Called by `alduin init` — never called implicitly.
   */
  async generateAndStoreAuditKey(): Promise<string> {
    const { randomBytes } = await import('node:crypto');
    const key = randomBytes(32).toString('hex');

    const stored = await this.tryKeytarAccount('set', AUDIT_ACCOUNT, key);
    if (stored) return key;

    throw new Error(
      'Cannot persist audit HMAC key: keytar is not installed and ALDUIN_AUDIT_HMAC_KEY is not set.\n' +
      'Either:\n' +
      '  • npm install keytar\n' +
      '  • Set ALDUIN_AUDIT_HMAC_KEY in your .env file to a random 64-char hex string.'
    );
  }

  private async tryKeytarAccount(
    op: 'get',
    account: string
  ): Promise<string | null>;
  private async tryKeytarAccount(
    op: 'set',
    account: string,
    value: string
  ): Promise<boolean>;
  private async tryKeytarAccount(
    op: 'get' | 'set',
    account: string,
    value?: string
  ): Promise<string | null | boolean> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const keytar = await import('keytar' as any) as {
        getPassword(s: string, a: string): Promise<string | null>;
        setPassword(s: string, a: string, v: string): Promise<void>;
      };
      if (op === 'get') {
        return await keytar.getPassword(SERVICE_NAME, account);
      }
      await keytar.setPassword(SERVICE_NAME, account, value!);
      return true;
    } catch {
      return op === 'get' ? null : false;
    }
  }

  private async tryKeytar(
    op: 'get'
  ): Promise<string | null>;
  private async tryKeytar(
    op: 'set',
    value: string
  ): Promise<boolean>;
  private async tryKeytar(
    op: 'get' | 'set',
    value?: string
  ): Promise<string | null | boolean> {
    try {
      // Dynamic import — keytar is an optional native dependency
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const keytar = await import('keytar' as any) as {
        getPassword(s: string, a: string): Promise<string | null>;
        setPassword(s: string, a: string, v: string): Promise<void>;
      };
      if (op === 'get') {
        return await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
      }
      await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, value!);
      return true;
    } catch {
      // keytar not installed — expected in many environments
      return op === 'get' ? null : false;
    }
  }
}

/**
 * In-memory keychain for testing — no OS dependencies.
 */
export class InMemoryKeychain implements KeychainProvider {
  private secret: string;
  private auditKey: string;

  constructor(secret = 'test-vault-secret', auditKey = 'test-audit-hmac-key') {
    this.secret = secret;
    this.auditKey = auditKey;
  }

  async getMasterSecret(): Promise<string> {
    return this.secret;
  }

  async setMasterSecret(secret: string): Promise<void> {
    this.secret = secret;
  }

  async getAuditHmacKey(): Promise<string> {
    return this.auditKey;
  }

  async setAuditHmacKey(key: string): Promise<void> {
    this.auditKey = key;
  }
}
