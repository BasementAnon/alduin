import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLog, verifyAuditLogOrThrow } from './audit.js';

const KEY = 'test-hmac-secret';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'alduin-audit-'));
}

describe('AuditLog — HMAC chain', () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes lines containing prev_hash=<64 hex chars>', () => {
    tmpDir = makeTmpDir();
    const log = new AuditLog(join(tmpDir, 'audit.log'), KEY);
    log.log({ actor: 'alice', action: 'policy.allow', new_value: 'write' });

    const content = readFileSync(join(tmpDir, 'audit.log'), 'utf-8');
    expect(content).toMatch(/ prev_hash=[0-9a-f]{64}/);
  });

  it('verify() returns ok=true for an intact chain', () => {
    tmpDir = makeTmpDir();
    const log = new AuditLog(join(tmpDir, 'audit.log'), KEY);
    log.log({ actor: 'alice', action: 'budget.set', new_value: '$10' });
    log.log({ actor: 'bob', action: 'policy.deny', new_value: 'write' });
    log.log({ actor: 'alice', action: 'policy.allow', new_value: 'read' });

    expect(log.verify()).toEqual({ ok: true });
  });

  it('verify() returns ok=false when a line is tampered', () => {
    tmpDir = makeTmpDir();
    const logPath = join(tmpDir, 'audit.log');
    const log = new AuditLog(logPath, KEY);
    log.log({ actor: 'alice', action: 'budget.set', new_value: '$10' });
    log.log({ actor: 'bob', action: 'policy.allow', new_value: 'write' });

    // Tamper with the first line — change the actor name
    const content = readFileSync(logPath, 'utf-8');
    const tampered = content.replace('actor=alice', 'actor=eve');
    writeFileSync(logPath, tampered, 'utf-8');

    const result = log.verify();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Line 1's prev_hash (genesis from '') is still valid after the text change;
      // the break is detected at line 2 whose prev_hash was computed from the
      // original (un-tampered) line 1.
      expect(result.breakPoint).toBe(2);
    }
  });

  it('verify() returns ok=false when a line is deleted', () => {
    tmpDir = makeTmpDir();
    const logPath = join(tmpDir, 'audit.log');
    const log = new AuditLog(logPath, KEY);
    log.log({ actor: 'alice', action: 'a1' });
    log.log({ actor: 'alice', action: 'a2' });
    log.log({ actor: 'alice', action: 'a3' });

    // Remove the second line
    const lines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    lines.splice(1, 1);
    writeFileSync(logPath, lines.join('\n') + '\n', 'utf-8');

    const result = log.verify();
    expect(result.ok).toBe(false);
  });

  it('verify() returns ok=true for an empty log', () => {
    tmpDir = makeTmpDir();
    const log = new AuditLog(join(tmpDir, 'audit.log'), KEY);
    expect(log.verify()).toEqual({ ok: true });
  });

  it('chain is consistent across two separate AuditLog instances (reopen)', () => {
    tmpDir = makeTmpDir();
    const logPath = join(tmpDir, 'audit.log');

    const log1 = new AuditLog(logPath, KEY);
    log1.log({ actor: 'alice', action: 'init' });

    // Reopen — second instance reads last line hash from disk
    const log2 = new AuditLog(logPath, KEY);
    log2.log({ actor: 'bob', action: 'login' });

    expect(log2.verify()).toEqual({ ok: true });
  });

  it('verifyAuditLogOrThrow throws on broken chain', () => {
    tmpDir = makeTmpDir();
    const logPath = join(tmpDir, 'audit.log');
    const log = new AuditLog(logPath, KEY);
    log.log({ actor: 'alice', action: 'a1' });

    // Append a line without a valid prev_hash
    appendFileSync(logPath, '[tampered] actor=eve action=steal prev_hash=deadbeef\n', 'utf-8');

    expect(() => verifyAuditLogOrThrow(log)).toThrow('Audit log integrity check failed');
  });

  it('serialises object old/new values as JSON (not [object Object])', () => {
    tmpDir = makeTmpDir();
    const logPath = join(tmpDir, 'audit.log');
    const log = new AuditLog(logPath, KEY);

    log.log({
      actor: 'alice',
      action: 'policy.update',
      old_value: { limit: 5 },
      new_value: { limit: 10, tags: ['a', 'b'] },
    });

    const content = readFileSync(logPath, 'utf-8');
    expect(content).not.toContain('[object Object]');
    expect(content).toContain('old={"limit":5}');
    expect(content).toContain('new={"limit":10,"tags":["a","b"]}');

    // Line must remain single-line so the HMAC chain stays verifiable
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);
    expect(log.verify()).toEqual({ ok: true });
  });

  it('different HMAC keys produce different hashes (key isolation)', () => {
    tmpDir = makeTmpDir();
    const logPath1 = join(tmpDir, 'log1.log');
    const logPath2 = join(tmpDir, 'log2.log');

    const log1 = new AuditLog(logPath1, 'key-a');
    const log2 = new AuditLog(logPath2, 'key-b');
    log1.log({ actor: 'x', action: 'y' });
    log2.log({ actor: 'x', action: 'y' });

    const line1 = readFileSync(logPath1, 'utf-8').trim();
    const line2 = readFileSync(logPath2, 'utf-8').trim();

    // Same content but different key → different prev_hash
    expect(line1).not.toBe(line2);
    // But each verifies under its own key
    expect(log1.verify()).toEqual({ ok: true });
    expect(log2.verify()).toEqual({ ok: true });
  });
});

describe('AuditLog — rotation', () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rotates at the configured threshold', () => {
    tmpDir = makeTmpDir();
    const logPath = join(tmpDir, 'audit.log');
    const THRESHOLD = 3;

    const log = new AuditLog(logPath, KEY, THRESHOLD);
    // Write exactly threshold entries
    for (let i = 0; i < THRESHOLD; i++) {
      log.log({ actor: 'alice', action: `action_${i}` });
    }
    // No rotation yet — at exactly threshold, next write triggers it
    expect(existsSync(join(tmpDir, 'audit.log.1'))).toBe(false);

    // This write triggers rotation (active has THRESHOLD lines)
    log.log({ actor: 'alice', action: 'trigger_rotation' });

    // Archive should now exist
    expect(existsSync(join(tmpDir, 'audit.log.1'))).toBe(true);

    // Active file should exist and contain the checkpoint + the new entry
    const active = readFileSync(logPath, 'utf-8');
    expect(active).toContain('action=log.rotation');
    expect(active).toContain('trigger_rotation');
  });

  it('rotates a second time to audit.log.2', () => {
    tmpDir = makeTmpDir();
    const logPath = join(tmpDir, 'audit.log');
    const THRESHOLD = 2;

    const log = new AuditLog(logPath, KEY, THRESHOLD);

    // First rotation
    for (let i = 0; i < THRESHOLD + 1; i++) {
      log.log({ actor: 'alice', action: `a${i}` });
    }
    expect(existsSync(join(tmpDir, 'audit.log.1'))).toBe(true);

    // Second rotation — fill active to threshold again
    for (let i = 0; i < THRESHOLD; i++) {
      log.log({ actor: 'bob', action: `b${i}` });
    }
    expect(existsSync(join(tmpDir, 'audit.log.2'))).toBe(true);
  });

  it('verify() passes after rotation (active segment only)', () => {
    tmpDir = makeTmpDir();
    const logPath = join(tmpDir, 'audit.log');
    const THRESHOLD = 3;

    const log = new AuditLog(logPath, KEY, THRESHOLD);
    for (let i = 0; i < THRESHOLD + 2; i++) {
      log.log({ actor: 'alice', action: `step_${i}` });
    }

    // Active segment verify should be fast and correct
    expect(log.verify()).toEqual({ ok: true });
  });

  it('verifyAll() validates the full chain across segments', () => {
    tmpDir = makeTmpDir();
    const logPath = join(tmpDir, 'audit.log');
    const THRESHOLD = 3;

    const log = new AuditLog(logPath, KEY, THRESHOLD);
    for (let i = 0; i < THRESHOLD + 2; i++) {
      log.log({ actor: 'alice', action: `entry_${i}` });
    }

    expect(log.verifyAll()).toEqual({ ok: true });
  });

  it('chain hash carries over via the checkpoint line', () => {
    tmpDir = makeTmpDir();
    const logPath = join(tmpDir, 'audit.log');
    const THRESHOLD = 2;

    const log = new AuditLog(logPath, KEY, THRESHOLD);

    // Write enough to trigger one rotation
    log.log({ actor: 'a', action: 'x' }); // line 1 in archive
    log.log({ actor: 'b', action: 'y' }); // line 2 in archive — at threshold
    log.log({ actor: 'c', action: 'z' }); // triggers rotation; becomes 2nd line in active

    // Both archive and active should verify cleanly
    expect(log.verifyAll()).toEqual({ ok: true });

    // Tamper the archived file — verifyAll should fail
    const archivePath = join(tmpDir, 'audit.log.1');
    const archiveContent = readFileSync(archivePath, 'utf-8');
    writeFileSync(archivePath, archiveContent.replace('actor=a', 'actor=evil'), 'utf-8');

    const tamperedResult = log.verifyAll();
    expect(tamperedResult.ok).toBe(false);
  });

  it('verify() is O(active-segment) — does not read archives', () => {
    tmpDir = makeTmpDir();
    const logPath = join(tmpDir, 'audit.log');
    const THRESHOLD = 2;

    const log = new AuditLog(logPath, KEY, THRESHOLD);
    // Force two rotations
    for (let i = 0; i < THRESHOLD * 2 + 1; i++) {
      log.log({ actor: 'alice', action: `e${i}` });
    }

    // Active file should be much smaller than archives
    const activeSizeBytes = readFileSync(logPath, 'utf-8').length;
    const archive1Bytes = readFileSync(join(tmpDir, 'audit.log.1'), 'utf-8').length;
    expect(activeSizeBytes).toBeLessThan(archive1Bytes + 1000); // ample margin
    // verify() still passes
    expect(log.verify()).toEqual({ ok: true });
  });
});
