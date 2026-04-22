import { describe, it, expect } from 'vitest';
import { safeFetch, SSRFBlockedError, classifyIp } from './safe-fetch.js';
import ipaddr from 'ipaddr.js';

describe('classifyIp', () => {
  it('rejects IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)', () => {
    // The IPv6 range() for ::ffff:a.b.c.d is "ipv4Mapped", not "loopback".
    // classifyIp must unwrap to the inner IPv4 and re-check — otherwise
    // an attacker could tunnel SSRF past the IPv4-only blocklist.
    const addr = ipaddr.parse('::ffff:127.0.0.1');
    const verdict = classifyIp(addr);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain('127.0.0.1');
      expect(verdict.reason).toContain('loopback');
    }
  });

  it('rejects IPv4-mapped IPv6 private 10.x (::ffff:10.0.0.1)', () => {
    const addr = ipaddr.parse('::ffff:10.0.0.1');
    const verdict = classifyIp(addr);
    expect(verdict.ok).toBe(false);
  });

  it('rejects 100.64.0.0/10 CGNAT addresses', () => {
    const verdict = classifyIp(ipaddr.parse('100.64.0.0'));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain('carrierGradeNat');
    }
  });

  it('rejects link-local 169.254.x.x', () => {
    const verdict = classifyIp(ipaddr.parse('169.254.169.254'));
    expect(verdict.ok).toBe(false);
  });

  it('rejects IPv6 loopback ::1', () => {
    const verdict = classifyIp(ipaddr.parse('::1'));
    expect(verdict.ok).toBe(false);
  });

  it('rejects IPv6 link-local fe80::', () => {
    const verdict = classifyIp(ipaddr.parse('fe80::1'));
    expect(verdict.ok).toBe(false);
  });

  it('rejects IPv6 unique-local fc00::', () => {
    const verdict = classifyIp(ipaddr.parse('fc00::1'));
    expect(verdict.ok).toBe(false);
  });

  it('rejects broadcast 255.255.255.255', () => {
    const verdict = classifyIp(ipaddr.parse('255.255.255.255'));
    expect(verdict.ok).toBe(false);
  });

  it('accepts public unicast IPv4 (1.1.1.1)', () => {
    const verdict = classifyIp(ipaddr.parse('1.1.1.1'));
    expect(verdict.ok).toBe(true);
  });

  it('accepts public unicast IPv6 (2606:4700:4700::1111)', () => {
    const verdict = classifyIp(ipaddr.parse('2606:4700:4700::1111'));
    expect(verdict.ok).toBe(true);
  });
});

describe('safeFetch SSRF rejections', () => {
  it('rejects an IP-literal URL pointing at loopback', async () => {
    await expect(safeFetch('http://127.0.0.1/foo')).rejects.toBeInstanceOf(SSRFBlockedError);
  });

  it('rejects an IPv4-mapped IPv6 loopback literal', async () => {
    await expect(safeFetch('http://[::ffff:127.0.0.1]/foo')).rejects.toBeInstanceOf(
      SSRFBlockedError
    );
  });

  it('rejects a 100.64.x.x CGNAT literal', async () => {
    await expect(safeFetch('http://100.64.0.1/foo')).rejects.toBeInstanceOf(SSRFBlockedError);
  });

  it('rejects when DNS resolves to a private IP', async () => {
    const fakeResolver = async () => [{ address: '10.0.0.1', family: 4 }];
    await expect(
      safeFetch('http://private.example.com/foo', { dnsResolver: fakeResolver })
    ).rejects.toBeInstanceOf(SSRFBlockedError);
  });

  it('rejects when DNS resolves to IPv4-mapped IPv6 loopback', async () => {
    const fakeResolver = async () => [{ address: '::ffff:127.0.0.1', family: 6 }];
    await expect(
      safeFetch('http://sneaky.example.com/foo', { dnsResolver: fakeResolver })
    ).rejects.toBeInstanceOf(SSRFBlockedError);
  });

  it('rejects when ANY resolved address is private (mixed record set)', async () => {
    const fakeResolver = async () => [
      { address: '1.2.3.4', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ];
    await expect(
      safeFetch('http://mixed.example.com/foo', { dnsResolver: fakeResolver })
    ).rejects.toBeInstanceOf(SSRFBlockedError);
  });

  it('rejects non-http(s) protocols', async () => {
    await expect(safeFetch('file:///etc/passwd')).rejects.toBeInstanceOf(SSRFBlockedError);
    await expect(safeFetch('ftp://example.com/file')).rejects.toBeInstanceOf(SSRFBlockedError);
  });
});
