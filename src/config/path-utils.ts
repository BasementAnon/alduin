import type { ZodTypeAny } from 'zod';
import { alduinConfigSchema } from './schema/index.js';

// ── Schema walking ────────────────────────────────────────────────────────────

/**
 * Walk the Zod schema tree and return the child schema at `key`, or null if
 * the key is unknown at this level.
 *
 * Handles:
 *   ZodObject  — checks .shape()
 *   ZodRecord  — any string key is valid; returns valueType schema
 *   ZodOptional / ZodDefault — transparent unwrap
 */
export function childSchema(schema: ZodTypeAny, key: string): ZodTypeAny | null {
  let s = schema;
  while (s._def.typeName === 'ZodOptional' || s._def.typeName === 'ZodDefault') {
    s = (s._def as { innerType: ZodTypeAny }).innerType;
  }
  if (s._def.typeName === 'ZodObject') {
    const shape: Record<string, ZodTypeAny> = (
      s._def as { shape: () => Record<string, ZodTypeAny> }
    ).shape();
    return Object.prototype.hasOwnProperty.call(shape, key) ? shape[key]! : null;
  }
  if (s._def.typeName === 'ZodRecord') {
    return (s._def as { valueType: ZodTypeAny }).valueType;
  }
  return null;
}

/**
 * Validate that `segments` form a known path in the AlduinConfig Zod schema.
 * Returns the leaf schema if valid, or throws with a descriptive message.
 */
export function validatePath(
  segments: string[],
  errorPrefix = 'config path'
): ZodTypeAny {
  let current: ZodTypeAny = alduinConfigSchema;
  const walked: string[] = [];
  for (const seg of segments) {
    const next = childSchema(current, seg);
    if (next === null) {
      throw new Error(
        `${errorPrefix}: unknown config path "${segments.join('.')}" — ` +
          `"${walked.join('.')}" has no key "${seg}".`
      );
    }
    walked.push(seg);
    current = next;
  }
  return current;
}

/**
 * Coerce a string value to the type expected by the schema at the leaf position.
 * Handles booleans and numbers; everything else stays a string.
 */
export function coerceValue(raw: string, leafSchema: ZodTypeAny): unknown {
  let s = leafSchema;
  while (s._def.typeName === 'ZodOptional' || s._def.typeName === 'ZodDefault') {
    s = (s._def as { innerType: ZodTypeAny }).innerType;
  }
  if (s._def.typeName === 'ZodBoolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  }
  if (s._def.typeName === 'ZodNumber') {
    const n = Number(raw);
    if (!Number.isNaN(n)) return n;
  }
  return raw;
}

// ── Deep object navigation ────────────────────────────────────────────────────

/**
 * Set a nested value inside `obj` by following `segments`.
 * Intermediate objects are created if missing.
 */
export function setDeep(
  obj: Record<string, unknown>,
  segments: string[],
  value: unknown
): void {
  let cursor = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (
      typeof cursor[seg] !== 'object' ||
      cursor[seg] === null ||
      Array.isArray(cursor[seg])
    ) {
      cursor[seg] = {};
    }
    cursor = cursor[seg] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]!] = value;
}

/**
 * Get a nested value from `obj` by following `segments`.
 * Returns `undefined` if any segment is missing.
 */
export function getDeep(obj: Record<string, unknown>, segments: string[]): unknown {
  let cursor: unknown = obj;
  for (const seg of segments) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

/**
 * Delete a nested key from `obj` by following `segments`.
 * Returns true if the key existed and was deleted; false otherwise.
 */
export function deleteDeep(obj: Record<string, unknown>, segments: string[]): boolean {
  if (segments.length === 0) return false;
  let cursor: unknown = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) {
      return false;
    }
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  const lastSeg = segments[segments.length - 1]!;
  if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) {
    return false;
  }
  const parent = cursor as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(parent, lastSeg)) return false;
  delete parent[lastSeg];
  return true;
}
