/**
 * PluginContext — the ambient context the host passes to every plugin
 * method call.  Plugins use this for logging, config access, and
 * credential retrieval without reaching into Alduin internals.
 */
/** Logger interface exposed to plugins. */
export interface PluginLogger {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
    debug(msg: string, ...args: unknown[]): void;
}
/**
 * Context passed to plugin methods at call time.
 *
 * The host constructs this per-call; plugins never construct it themselves.
 * New fields can be added in minor versions (additive-only contract).
 */
export interface PluginContext {
    /** Scoped logger (messages are prefixed with the plugin ID). */
    log: PluginLogger;
    /**
     * Retrieve a credential from the host's CredentialVault by handle.
     * Returns null if the credential does not exist.
     */
    getCredential(handle: string): Promise<string | null>;
    /**
     * Read a plugin-scoped config value.
     * Returns undefined if the key does not exist.
     */
    getConfig<T = unknown>(key: string): T | undefined;
}
//# sourceMappingURL=context.d.ts.map