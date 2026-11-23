import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter } from './limits.ts';

describe('SlidingWindowLimiter', () => {
  it('charges the full cost of a take', () => {
    const l = new SlidingWindowLimiter(5, 60_000, () => 0);
    expect(l.take('k', 3).ok).toBe(true);
    expect(l.check('k', 3).ok).toBe(false);
    expect(l.take('k', 2).ok).toBe(true);
    expect(l.check('k', 1).ok).toBe(false);
  });

  it('refuses a cost above the whole limit instead of clamping it', () => {
    const l = new SlidingWindowLimiter(1, 60_000, () => 0);
    expect(l.check('k', 3)).toEqual({ ok: false, retryAfterSec: 60 });
    expect(l.take('k', 3).ok).toBe(false);
    // Nothing was recorded, so a call that fits still goes through.
    expect(l.take('k', 1).ok).toBe(true);
  });

  it('frees hits once the window passes', () => {
    let now = 0;
    const l = new SlidingWindowLimiter(2, 1000, () => now);
    l.take('k', 2);
    expect(l.check('k')).toEqual({ ok: false, retryAfterSec: 1 });
    now = 1001;
    expect(l.check('k').ok).toBe(true);
  });
});
