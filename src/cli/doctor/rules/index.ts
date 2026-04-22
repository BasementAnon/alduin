/**
 * Barrel export — all doctor rules in execution order.
 */

import type { DoctorRule } from '../rule.js';
import { configValidRule } from './config-valid.js';
import { legacyKeysRule } from './legacy-keys.js';
import { catalogVersionRule } from './catalog-version.js';
import { modelsExistRule } from './models-exist.js';
import { modelsDeprecatedRule } from './models-deprecated.js';
import { envOverridesRule } from './env-overrides.js';
import { dotenvSecretsRule } from './dotenv-secrets.js';
import { schemaSyncRule } from './schema-sync.js';
import { pluginSchemaDriftRule } from './plugin-schema-drift.js';
import { vaultEncryptRule } from './vault-encrypt.js';
import { danglingRefsRule } from './dangling-refs.js';

/**
 * All doctor rules in recommended execution order.
 * Config-level checks first, then model checks, then env/secrets, then plugins.
 */
export const ALL_RULES: DoctorRule[] = [
  configValidRule,
  legacyKeysRule,
  catalogVersionRule,
  modelsExistRule,
  modelsDeprecatedRule,
  envOverridesRule,
  dotenvSecretsRule,
  schemaSyncRule,
  pluginSchemaDriftRule,
  vaultEncryptRule,
  danglingRefsRule,
];

export {
  configValidRule,
  legacyKeysRule,
  catalogVersionRule,
  modelsExistRule,
  modelsDeprecatedRule,
  envOverridesRule,
  dotenvSecretsRule,
  schemaSyncRule,
  pluginSchemaDriftRule,
  vaultEncryptRule,
  danglingRefsRule,
};
