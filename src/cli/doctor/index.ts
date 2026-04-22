/**
 * Doctor module barrel export.
 */

export { type DoctorRule, type DoctorCheckResult, type DoctorContext, type CheckStatus } from './rule.js';
export { runRules, type RunnerResult } from './runner.js';
export { ALL_RULES } from './rules/index.js';
