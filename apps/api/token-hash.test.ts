import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearViewerCache, fetchViewer } from './review-context.ts';
import { tokenHash } from './token-hash.ts';

afterEach(() => {
  clearViewerCache();
  vi.unstubAllGlobals();
});

describe('tokenHash', () => {
  it('is the lowercase hex SHA-256 (known vectors)', async () => {
    expect(await tokenHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(await tokenHash('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('zero-pads every byte to 64 characters (matches node:crypto)', async () => {
    let sawLowByte = false;
    for (let i = 0; i < 300; i++) {
      const token = `ghp_token${i}`;
      const h = await tokenHash(token);
      expect(h).toBe(createHash('sha256').update(token).digest('hex'));
      expect(h).toHaveLength(64);
      // a byte below 0x10 appears as "0x"; compare with unpadded output
      const unpadded = [...createHash('sha256').update(token).digest()]
        .map((x) => x.toString(16))
        .join('');
      if (unpadded.length < 64) sawLowByte = true;
    }
    expect(sawLowByte).toBe(true);
  });

  it('differs per token (never "[object Promise]")', async () => {
    expect(await tokenHash('a')).not.toBe(await tokenHash('b'));
    expect(await tokenHash('a')).not.toContain('object');
  });
});

describe('fetchViewer cache key', () => {
  const stub = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ id: 7, login: 'me' }, { status: 200 })),
    );

  it('reuses the cache for the same token and separates tokens', async () => {
    stub();
    await fetchViewer('tok-a');
    await fetchViewer('tok-a');
    expect(fetch).toHaveBeenCalledTimes(1);
    await fetchViewer('tok-b');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
