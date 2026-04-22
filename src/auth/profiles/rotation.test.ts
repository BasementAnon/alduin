import { describe, it, expect, beforeEach } from 'vitest';

import { ProfileRotator } from './rotation.js';
import type { AuthProfile } from './types.js';

function makeProfile(overrides: Partial<AuthProfile> & { id: string; provider: string }): AuthProfile {
  return {
    vaultScope: `providers/${overrides.provider}/keys/0`,
    priority: 0,
    health: 'healthy',
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    retryAfter: null,
    ...overrides,
  };
}

describe('ProfileRotator', () => {
  let rotator: ProfileRotator;

  beforeEach(() => {
    rotator = new ProfileRotator({
      maxConsecutiveFailures: 3,
      deadCooldownMs: 5000,
      degradedCooldownMs: 1000,
    });
  });

  describe('select()', () => {
    it('returns null when no profiles exist', () => {
      expect(rotator.select()).toBeNull();
    });

    it('returns the single profile when only one exists', () => {
      const p = makeProfile({ id: 'key-1', provider: 'anthropic' });
      rotator.addProfile(p);
      expect(rotator.select()).toBe(p);
    });

    it('prefers lower priority number', () => {
      rotator.addProfile(makeProfile({ id: 'key-2', provider: 'anthropic', priority: 2 }));
      rotator.addProfile(makeProfile({ id: 'key-1', provider: 'anthropic', priority: 1 }));
      rotator.addProfile(makeProfile({ id: 'key-0', provider: 'anthropic', priority: 0 }));

      const selected = rotator.select();
      expect(selected?.id).toBe('key-0');
    });

    it('prefers healthy over degraded', () => {
      rotator.addProfile(makeProfile({
        id: 'degraded', provider: 'anthropic', priority: 0, health: 'degraded',
        lastFailureAt: 0, // long ago, cooldown elapsed
      }));
      rotator.addProfile(makeProfile({
        id: 'healthy', provider: 'anthropic', priority: 1, health: 'healthy',
      }));

      const selected = rotator.select();
      expect(selected?.id).toBe('healthy');
    });

    it('skips rate-limited profiles', () => {
      rotator.addProfile(makeProfile({
        id: 'limited', provider: 'anthropic', priority: 0,
        retryAfter: Date.now() + 60_000, // 1 minute from now
      }));
      rotator.addProfile(makeProfile({
        id: 'available', provider: 'anthropic', priority: 1,
      }));

      const selected = rotator.select();
      expect(selected?.id).toBe('available');
    });

    it('returns null when all profiles are rate-limited', () => {
      rotator.addProfile(makeProfile({
        id: 'limited-1', provider: 'anthropic', priority: 0,
        retryAfter: Date.now() + 60_000,
      }));
      rotator.addProfile(makeProfile({
        id: 'limited-2', provider: 'anthropic', priority: 1,
        retryAfter: Date.now() + 60_000,
      }));

      expect(rotator.select()).toBeNull();
    });

    it('skips dead profiles within cooldown', () => {
      rotator.addProfile(makeProfile({
        id: 'dead', provider: 'anthropic', priority: 0,
        health: 'dead', lastFailureAt: Date.now(), // just now
      }));
      rotator.addProfile(makeProfile({
        id: 'healthy', provider: 'anthropic', priority: 1,
      }));

      const selected = rotator.select();
      expect(selected?.id).toBe('healthy');
    });

    it('retries dead profiles after cooldown', () => {
      rotator.addProfile(makeProfile({
        id: 'dead', provider: 'anthropic', priority: 0,
        health: 'dead', lastFailureAt: Date.now() - 10_000, // 10s ago, > 5s cooldown
      }));

      const selected = rotator.select();
      expect(selected?.id).toBe('dead');
    });
  });

  describe('report()', () => {
    it('marks profile healthy on success', () => {
      const p = makeProfile({
        id: 'key-1', provider: 'anthropic',
        health: 'degraded', consecutiveFailures: 2,
      });
      rotator.addProfile(p);

      rotator.report('key-1', { success: true });

      expect(p.health).toBe('healthy');
      expect(p.consecutiveFailures).toBe(0);
      expect(p.lastSuccessAt).not.toBeNull();
      expect(p.retryAfter).toBeNull();
    });

    it('advances to degraded on 429', () => {
      const p = makeProfile({ id: 'key-1', provider: 'anthropic' });
      rotator.addProfile(p);

      rotator.report('key-1', { success: false, statusCode: 429, retryAfterMs: 5000 });

      expect(p.health).toBe('degraded');
      expect(p.consecutiveFailures).toBe(1);
      expect(p.retryAfter).toBeGreaterThan(Date.now());
    });

    it('advances to degraded on 5xx', () => {
      const p = makeProfile({ id: 'key-1', provider: 'anthropic' });
      rotator.addProfile(p);

      rotator.report('key-1', { success: false, statusCode: 503 });

      expect(p.health).toBe('degraded');
    });

    it('advances to dead after maxConsecutiveFailures', () => {
      const p = makeProfile({ id: 'key-1', provider: 'anthropic' });
      rotator.addProfile(p);

      // 3 consecutive failures (maxConsecutiveFailures = 3)
      rotator.report('key-1', { success: false, statusCode: 500 });
      rotator.report('key-1', { success: false, statusCode: 500 });
      rotator.report('key-1', { success: false, statusCode: 500 });

      expect(p.health).toBe('dead');
    });

    it('rotation advances on simulated 429 sequence', () => {
      // This is the key test from the runbook:
      // "rotation advances on simulated 429"
      const keyA = makeProfile({ id: 'key-a', provider: 'anthropic', priority: 0 });
      const keyB = makeProfile({ id: 'key-b', provider: 'anthropic', priority: 1 });
      rotator.addProfile(keyA);
      rotator.addProfile(keyB);

      // First request uses key-a (priority 0)
      expect(rotator.select()?.id).toBe('key-a');

      // key-a gets rate-limited
      rotator.report('key-a', { success: false, statusCode: 429, retryAfterMs: 60_000 });

      // Next request should use key-b (key-a is rate-limited)
      expect(rotator.select()?.id).toBe('key-b');

      // key-b succeeds
      rotator.report('key-b', { success: true });

      // key-a is still rate-limited, so key-b again
      expect(rotator.select()?.id).toBe('key-b');
    });
  });

  describe('resetHealth()', () => {
    it('resets a dead profile to healthy', () => {
      const p = makeProfile({
        id: 'dead', provider: 'anthropic',
        health: 'dead', consecutiveFailures: 5,
        retryAfter: Date.now() + 60_000,
      });
      rotator.addProfile(p);

      rotator.resetHealth('dead');

      expect(p.health).toBe('healthy');
      expect(p.consecutiveFailures).toBe(0);
      expect(p.retryAfter).toBeNull();
    });
  });

  describe('healthSnapshot()', () => {
    it('returns all profiles sorted by priority', () => {
      rotator.addProfile(makeProfile({ id: 'b', provider: 'anthropic', priority: 1 }));
      rotator.addProfile(makeProfile({ id: 'a', provider: 'anthropic', priority: 0 }));

      const snap = rotator.healthSnapshot();
      expect(snap).toHaveLength(2);
      expect(snap[0].id).toBe('a');
      expect(snap[1].id).toBe('b');
    });
  });
});
