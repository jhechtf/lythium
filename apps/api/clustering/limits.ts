/**
 * Cost and abuse limits for AI clustering (LYT-63). Both are in memory, per
 * API instance: with several instances a user gets the limit on each, and a
 * cached preview is only reused on the instance that made it. That is fine
 * for a preview (losing it costs one more model call); move both to a
 * shared store if the API scales out.
 */

/** At most `limit` hits per key in any `windowMs`. */
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private now: () => number = Date.now,
  ) {}

  /**
   * Whether `cost` hits fit now, or how many seconds until they do. Doesn't
   * record anything. A cost above the limit is charged as the limit.
   */
  check(
    key: string,
    cost = 1,
  ): { ok: true } | { ok: false; retryAfterSec: number } {
    const now = this.now();
    const recent = this.recent(key, now);
    const n = Math.min(Math.max(cost, 1), this.limit);
    if (recent.length + n <= this.limit) return { ok: true };
    // Enough of the oldest hits have to expire to leave room for n.
    const mustExpire = recent[recent.length + n - this.limit - 1];
    const retryAfterSec = Math.max(
      1,
      Math.ceil((mustExpire + this.windowMs - now) / 1000),
    );
    return { ok: false, retryAfterSec };
  }

  /** Record `cost` hits, or say how many seconds until they're allowed. */
  take(
    key: string,
    cost = 1,
  ): { ok: true } | { ok: false; retryAfterSec: number } {
    const allowed = this.check(key, cost);
    if (!allowed.ok) return allowed;
    const now = this.now();
    const recent = this.recent(key, now);
    const n = Math.min(Math.max(cost, 1), this.limit);
    for (let i = 0; i < n; i++) recent.push(now);
    this.hits.set(key, recent);
    // Keep the map from growing without bound: drop keys with no recent hits.
    if (this.hits.size > 10_000) {
      for (const [k, ts] of this.hits) {
        if (ts.every((t) => t <= now - this.windowMs)) this.hits.delete(k);
      }
    }
    return { ok: true };
  }

  private recent(key: string, now: number) {
    const recent = (this.hits.get(key) ?? []).filter(
      (t) => t > now - this.windowMs,
    );
    this.hits.set(key, recent);
    return recent;
  }

  clear() {
    this.hits.clear();
  }
}

/** A small LRU with a TTL. Map order is insertion order; a hit re-inserts. */
export class TtlCache<V> {
  private entries = new Map<string, { value: V; expires: number }>();

  constructor(
    readonly max: number,
    readonly ttlMs: number,
    private now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    this.entries.delete(key);
    if (hit.expires <= this.now()) return undefined;
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V) {
    this.entries.delete(key);
    if (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expires: this.now() + this.ttlMs });
  }

  /** The live value without refreshing its LRU position. */
  peek(key: string): V | undefined {
    const hit = this.entries.get(key);
    return hit && hit.expires > this.now() ? hit.value : undefined;
  }

  delete(key: string) {
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }
}
