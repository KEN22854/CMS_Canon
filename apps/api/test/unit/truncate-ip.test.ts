import { describe, expect, it } from 'vitest';
import { truncateIp } from '../../src/modules/forms/forms.service';

describe('truncateIp (form submissions keep only the network)', () => {
  it('keeps the /24 of IPv4, including IPv4-mapped IPv6', () => {
    expect(truncateIp('203.0.113.77')).toBe('203.0.113.0');
    expect(truncateIp('::ffff:127.0.0.1')).toBe('127.0.0.0');
    expect(truncateIp('::FFFF:198.51.100.9')).toBe('198.51.100.0');
  });

  it('keeps the /48 of IPv6, also when the address is compressed', () => {
    expect(truncateIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe('2001:db8:85a3::');
    expect(truncateIp('2001:db8::1')).toBe('2001:db8:0::');
    expect(truncateIp('::1')).toBe('0:0:0::');
    expect(truncateIp('fe80::1:2:3')).toBe('fe80:0:0::');
  });

  it('drops anything that is not an IP', () => {
    expect(truncateIp(undefined)).toBeNull();
    expect(truncateIp('')).toBeNull();
    expect(truncateIp('not-an-ip')).toBeNull();
  });
});
