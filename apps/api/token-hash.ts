/**
 * Lowercase hex SHA-256 of a token, for cache keys (a token is never used as a
 * key). Uses the global Web Crypto API, which exists on Node and Workers
 * without `node:crypto`; it is async, so callers must await it.
 */
export async function tokenHash(token: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
