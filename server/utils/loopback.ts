/**
 * Helper para detectar endereços de loopback (IPv4, IPv6 e mapped).
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', 'localhost.localdomain']);

function isLoopbackIPv4(address: string): boolean {
  return address.startsWith('127.') || address === '127.0.0.1';
}

function isLoopbackIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::1') return true;
  // IPv4-mapped / IPv4-compatible loopback
  if (normalized.endsWith('127.0.0.1')) {
    const prefix = normalized.slice(0, -'127.0.0.1'.length);
    // Accept ::ffff:127.0.0.1 or ::127.0.0.1
    return /^(::ffff:|::)$/i.test(prefix);
  }
  return false;
}

export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const trimmed = address.trim();
  if (trimmed === '') return false;
  if (LOOPBACK_HOSTNAMES.has(trimmed.toLowerCase())) return true;
  if (isLoopbackIPv4(trimmed)) return true;
  if (isLoopbackIPv6(trimmed)) return true;
  return false;
}
