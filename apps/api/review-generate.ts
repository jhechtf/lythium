import { ReviewStateError } from '@lythium/db';
import { Hono } from 'hono';
import { AnthropicClusterer } from './clustering/anthropic.ts';
import type { Clusterer } from './clustering/clusterer.ts';
import {
  byDirectory,
  chunkFiles,
  type GenerateResult,
  generateGroups,
  modelCalls,
} from './clustering/generate.ts';
import { SlidingWindowLimiter, TtlCache } from './clustering/limits.ts';
import type { PRFile } from './pr-files.ts';
import {
  beforeBody,
  filesAtHead,
  guidedRequest,
  isObject,
  jsonBody,
  type ReviewEnv,
  requireEditable,
  stateError,
} from './review-groups.ts';
import type {
  ClusterGranularity,
  ClusterStrategy,
  GenerateGroupsResponse,
} from './types.ts';

/**
 * `POST …/groups/generate` (LYT-63): preview AI-generated groups. Nothing is
 * saved; accepting the preview is `PUT …/groups` with `source: 'ai'`.
 *
 * Only callers who could accept the preview (the PR's author or someone with
 * push access) may generate one, since each model call costs money.
 */

// ---------------------------------------------------------------------------
// Configuration: the API's first credential of its own.
// ---------------------------------------------------------------------------

let clusterer: Clusterer | null | undefined;

/**
 * The configured clusterer, or null for directory grouping only.
 * `CLUSTER_PROVIDER` is `anthropic` (the default when `ANTHROPIC_API_KEY` is
 * set) or `none`. `CLUSTER_MODEL` overrides the model id.
 */
export function getClusterer(): Clusterer | null {
  if (clusterer === undefined) {
    // An empty variable counts as unset.
    const provider =
      process.env.CLUSTER_PROVIDER ||
      (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'none');
    clusterer =
      provider === 'anthropic' && process.env.ANTHROPIC_API_KEY
        ? new AnthropicClusterer({
            apiKey: process.env.ANTHROPIC_API_KEY,
            model: process.env.CLUSTER_MODEL || undefined,
          })
        : null;
  }
  return clusterer;
}

/** Tests: inject a clusterer, null for none, undefined to read env again. */
export function setClusterer(c: Clusterer | null | undefined) {
  clusterer = c;
}

// ---------------------------------------------------------------------------
// Limits: model calls per user and per instance, and previews cached by
// head sha. A generation is charged one per model call it makes (a large PR
// is several chunk calls plus a merge), so a big PR costs more of the budget.
// ---------------------------------------------------------------------------

/**
 * Model calls per GitHub user per window. Cache hits don't count. Must be at
 * least the most one generation can make (12 chunks + 1 merge).
 */
export const GENERATE_RATE = { limit: 40, windowMs: 10 * 60_000 };

/**
 * Model calls per API instance per window, across all users. A user limit
 * alone doesn't bound spend: anyone can open PRs in their own repo, and
 * accounts are free. `CLUSTER_MAX_CALLS_PER_HOUR` overrides the default.
 * When it's used up, generation falls back to directory grouping.
 */
export const GLOBAL_MODEL_RATE = {
  limit: positiveInt(process.env.CLUSTER_MAX_CALLS_PER_HOUR, 300),
  windowMs: 60 * 60_000,
};
/**
 * `value` as a positive integer, else `fallback`. A zero, negative or
 * fractional budget would switch the limit off rather than tighten it.
 */
export function positiveInt(value: string | undefined, fallback: number) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Cached previews: per PR head sha + settings. */
export const PREVIEW_CACHE = { max: 500, ttlMs: 60 * 60_000 };

const limiter = new SlidingWindowLimiter(
  GENERATE_RATE.limit,
  GENERATE_RATE.windowMs,
);
const globalLimiter = new SlidingWindowLimiter(
  GLOBAL_MODEL_RATE.limit,
  GLOBAL_MODEL_RATE.windowMs,
);
// Promises, so two identical requests in flight share one model call.
const previews = new TtlCache<Promise<GenerateResult>>(
  PREVIEW_CACHE.max,
  PREVIEW_CACHE.ttlMs,
);

/** Tests: forget per-user rate-limit hits only. */
export function resetUserLimits() {
  limiter.clear();
}

/** Tests: forget rate-limit hits and cached previews. */
export function resetGenerateState() {
  limiter.clear();
  globalLimiter.clear();
  previews.clear();
}

const STRATEGIES: readonly ClusterStrategy[] = [
  'feature',
  'layer',
  'directory',
];
const GRANULARITIES: readonly ClusterGranularity[] = [
  'coarse',
  'balanced',
  'fine',
];

function parseGenerate(v: unknown) {
  if (!isObject(v)) throw new ReviewStateError('Expected a JSON object');
  if (!STRATEGIES.includes(v.strategy as ClusterStrategy)) {
    throw new ReviewStateError(
      `strategy must be one of ${STRATEGIES.join(', ')}`,
    );
  }
  const granularity = v.granularity ?? 'balanced';
  if (!GRANULARITIES.includes(granularity as ClusterGranularity)) {
    throw new ReviewStateError(
      `granularity must be one of ${GRANULARITIES.join(', ')}`,
    );
  }
  if (v.regenerate !== undefined && typeof v.regenerate !== 'boolean') {
    throw new ReviewStateError('regenerate must be true or false');
  }
  return {
    strategy: v.strategy as ClusterStrategy,
    granularity: granularity as ClusterGranularity,
    regenerate: v.regenerate === true,
  };
}

export const reviewGenerateRoutes = new Hono<ReviewEnv>().post(
  '/groups/generate',
  ...beforeBody(1),
  async (c) => {
    try {
      const { strategy, granularity, regenerate } = parseGenerate(
        await jsonBody(c),
      );
      // No files yet: a cache hit needs only the head sha.
      const req = await guidedRequest(c, { files: false });
      if ('error' in req) return req.error;
      const pr = requireEditable(c, req);
      if (pr instanceof Response) return pr;

      let model = strategy === 'directory' ? null : getClusterer();
      const key = `${pr.owner}/${pr.repo}#${pr.prNumber}@${pr.headSha}:${strategy}:${granularity}`;
      const cachedPreview = () =>
        regenerate || !model ? undefined : previews.get(key);
      let cached = false;
      let pending = cachedPreview();
      let files: PRFile[] = [];
      if (!pending) {
        const fetched = await filesAtHead(c, req);
        if (fetched instanceof Response) return fetched;
        files = fetched;
        // An identical request may have started generating while we fetched.
        pending = cachedPreview();
      }
      if (pending) {
        cached = true;
      } else {
        const chunks = model ? chunkFiles(files) : [];
        const input = {
          strategy,
          granularity,
          pr: { title: req.resolved.title, body: req.resolved.body },
          files,
          chunks,
        };
        const cost = modelCalls(chunks);
        let overBudget = false;
        // An empty PR makes no model call, so it isn't charged.
        if (model && cost > 0) {
          const user = String(req.viewer.id);
          // Check the user's own limit first, so a 429 doesn't spend the
          // instance budget.
          const allowed = limiter.check(user, cost);
          if (!allowed.ok) {
            c.header('Retry-After', String(allowed.retryAfterSec));
            return c.json(
              {
                error: 'Too many generations; try again later',
                retryAfter: allowed.retryAfterSec,
              },
              429,
            );
          }
          // A cost above the whole budget is refused, not clamped.
          if (globalLimiter.take('*', cost).ok) {
            limiter.take(user, cost);
          } else {
            overBudget = true;
            model = null;
          }
        }
        const generating = overBudget
          ? Promise.resolve(byDirectory(input, 'rate_limited'))
          : generateGroups(input, model);
        pending = generating;
        if (model) {
          previews.set(key, generating);
          // Only keep model results: a fallback should retry the model. A
          // regenerate may have replaced this entry by the time it settles;
          // only evict it if it's still ours.
          const evict = () => {
            if (previews.peek(key) === generating) previews.delete(key);
          };
          generating.then((r) => {
            if (r.generatedBy !== 'model') evict();
          }, evict);
        }
      }
      const result = await pending;
      return c.json<GenerateGroupsResponse>({
        headSha: pr.headSha,
        strategy,
        granularity,
        ...result,
        cached,
      });
    } catch (err) {
      return stateError(c, err);
    }
  },
);
