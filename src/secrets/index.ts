export { CredentialVault } from './vault.js';
export type { SecretHandle } from './vault.js';
export { isSecretRef, resolveSecret, resolveSecrets } from './ref.js';
export type { SecretRef, SecretInput } from './ref.js';
export { migrateFromDotenv, MIGRATION_SCOPES } from './migrate.js';
export type { MigrationResult, MigrationEnvKey } from './migrate.js';
