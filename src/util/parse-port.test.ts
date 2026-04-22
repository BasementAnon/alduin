import { describe, it, expect, vi, afterEach } from 'vitest';
import { parsePort } from './parse-port.js';

describe('parsePort', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockExit(): ReturnType<typeof vi.spyOn> {
    // Cast needed: process.exit's return type is `never`, but in tests we
    // want the mock to return void so execution continues past the call.
    return vi.spyOn(process, 'exit').mockImplementation((() => {}) as typeof process.exit);
  }

  // ── Valid inputs ────────────────────────────────────────────────────────────

  it('returns 3000 when PORT is undefined (default)', () => {
    expect(parsePort(undefined)).toBe(3000);
  });

  it('returns the numeric value for a valid port string', () => {
    expect(parsePort('8080')).toBe(8080);
  });

  it('accepts the boundary values 1 and 65535', () => {
    expect(parsePort('1')).toBe(1);
    expect(parsePort('65535')).toBe(65535);
  });

  // ── Invalid inputs — must call process.exit(1) ──────────────────────────────

  it('exits 1 for a non-numeric string', () => {
    const exit = mockExit();
    parsePort('abc');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 for a string with a trailing non-digit suffix (e.g. "3000;evil")', () => {
    const exit = mockExit();
    parsePort('3000;evil');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 for a port with a leading plus sign ("+")', () => {
    const exit = mockExit();
    parsePort('+3000');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 for PORT=0 (below range)', () => {
    const exit = mockExit();
    parsePort('0');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 for PORT=65536 (above range)', () => {
    const exit = mockExit();
    parsePort('65536');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 for a negative port', () => {
    const exit = mockExit();
    parsePort('-1');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 for an empty string', () => {
    const exit = mockExit();
    parsePort('');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('writes the offending value to stderr before exiting', () => {
    const exit = mockExit();
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    parsePort('bad', 'test-label');

    expect(write).toHaveBeenCalledWith(expect.stringMatching(/\[test-label\]/));
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/Invalid PORT/));
    expect(exit).toHaveBeenCalledWith(1);
  });
});
