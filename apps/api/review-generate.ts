import { ReviewStateError } from '@lythium/db';
import { Hono } from 'hono';
import { AnthropicClusterer } from './clustering/anthropic.ts';
import type { Clusterer } from './clustering/clusterer.ts';
import { type GenerateResult, generateGroups } from './clustering/generate.ts';
import { SlidingWindowLimiter, TtlCache } from './clustering/limits.ts';
import { requireReviewDb } from './review-context.ts';
import {
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
// Limits: model generations per user, and previews cached by head sha.
// ---------------------------------------------------------------------------

/** Model generations per GitHub user per window. Cache hits don't count. */
export const GENERATE_RATE = { limit: 10, windowMs: 10 * 60_000 };
/** Cached previews: per PR head sha + settings. */
export const PREVIEW_CACHE = { max: 500, ttlMs: 60 * 60_000 };

const limiter = new SlidingWindowLimiter(
  GENERATE_RATE.limit,
  GENERATE_RATE.windowMs,
);
// Promises, so two identical requests in flight share one model call.
const previews = new TtlCache<Promise<GenerateResult>>(
  PREVIEW_CACHE.max,
  PREVIEW_CACHE.ttlMs,
);

/** Tests: forget rate-limit hits and cached previews. */
export function resetGenerateState() {
  limiter.clear();
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
  requireReviewDb,
  async (c) => {
    try {
      const { strategy, granularity, regenerate } = parseGenerate(
        await jsonBody(c),
      );
      const req = await guidedRequest(c, { files: true });
      if ('error' in req) return req.error;
      const pr = requireEditable(c, req);
      if (pr instanceof Response) return pr;

      const model = strategy === 'directory' ? null : getClusterer();
      const key = `${pr.owner}/${pr.repo}#${pr.prNumber}@${pr.headSha}:${strategy}:${granularity}`;
      let cached = false;
      let pending = regenerate || !model ? undefined : previews.get(key);
      if (pending) {
        cached = true;
      } else {
        if (model) {
          const allowed = limiter.take(String(req.viewer.id));
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
        }
        pending = generateGroups(
          {
            strategy,
            granularity,
            pr: { title: req.resolved.title, body: req.resolved.body },
            files: req.prFiles,
          },
          model,
        );
        if (model) {
          previews.set(key, pending);
          // Only keep model results: a fallback should retry the model.
          pending.then(
            (r) => {
              if (r.generatedBy !== 'model') previews.delete(key);
            },
            () => previews.delete(key),
          );
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
