import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import {
  type FetchResult,
  githubErrorMessage,
  githubFetch,
  githubFetchAll,
  isGithubName,
  isRateLimited,
  upstreamError,
} from './github.ts';
import { type GithubReview, mapReviewers } from './pr-details.ts';
import { fetchViewer } from './review-context.ts';
import { bearerToken } from './route-params.ts';
import type {
  InboxGroup,
  InboxItem,
  InboxRepository,
  InboxResponse,
  InboxStatus,
} from './types.ts';

/**
 * Review inbox (LYT-59): PRs awaiting the caller's review, from GitHub search
 * (`review-requested:@me`) with the caller's token, enriched per PR.
 *
 * Decisions:
 * - The candidate set is always the scope search. A `q` is a second search
 *   (scope + q) whose hits are intersected with it, so no `q` can widen the
 *   inbox. `q` is GitHub search syntax, but qualifiers/operators that could
 *   change the scope (`is:`, `review-requested:`, `OR`, parentheses…) → 400.
 * - Counts, pending total and repositories cover the whole inbox, ignoring
 *   filters and paging.
 * - At most `MAX_CANDIDATES` PRs are read (one search page); anything beyond
 *   that, or incomplete results, sets `complete: false`.
 */

export const MAX_CANDIDATES = 100;
const ENRICH_CONCURRENCY = 8;
const DEFAULT_PER_PAGE = 25;
const MAX_PER_PAGE = 100;
const MAX_Q_LENGTH = 256;
// The timeline only feeds `requested_at` (optional) and is paged serially per
// PR, for up to 100 PRs: keep it short. Longer timelines give `null`.
const TIMELINE_MAX_PAGES = 2;
const TIMELINE_CAP = TIMELINE_MAX_PAGES * 100;

export const SEARCH_CACHE_TTL_MS = 30_000;
export const ENRICH_CACHE_TTL_MS = 5 * 60_000;
const SEARCH_CACHE_MAX = 200;
const ENRICH_CACHE_MAX = 2000;

const STATUSES: readonly InboxStatus[] = [
  'open',
  'changes_requested',
  'approved',
];

const SCOPE = 'is:pr is:open archived:false review-requested:@me';

// Anything that could turn the scope into something else.
const SCOPE_BREAKING =
  /(^|[\s"'(])-?(is|type|state|review-requested|user-review-requested|team-review-requested|reviewed-by|review|archived):/i;
const hasOperator = (q: string) =>
  /(^|\s)(OR|AND|NOT)(\s|$)/.test(q) || /[()]/.test(q);

// Caches are keyed by SHA-256 of the token (never the token), so one caller
// can't be served another's results. Map order = insertion order.
const searchCache = new Map<string, { value: SearchHits; expires: number }>();
const enrichCache = new Map<string, { value: Enriched; expires: number }>();

/** Tests: forget cached searches and PR details. */
export function clearInboxCache() {
  searchCache.clear();
  enrichCache.clear();
}

const tokenKey = (token: string) =>
  createHash('sha256').update(token).digest('hex');

function cacheGet<T>(
  cache: Map<string, { value: T; expires: number }>,
  key: string,
): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires > Date.now()) return hit.value;
  cache.delete(key);
  return undefined;
}

function cacheSet<T>(
  cache: Map<string, { value: T; expires: number }>,
  max: number,
  ttl: number,
  key: string,
  value: T,
) {
  if (cache.size >= max) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expires: Date.now() + ttl });
}

interface Candidate {
  repository: string;
  number: number;
  updatedAt: string;
}

interface SearchHits {
  candidates: Candidate[];
  /** More matches than were read, or GitHub said the results are partial. */
  partial: boolean;
}

interface GithubSearchResponse {
  total_count?: number;
  incomplete_results?: boolean;
  items?: {
    number?: unknown;
    repository_url?: unknown;
    updated_at?: unknown;
    pull_request?: unknown;
  }[];
}

const keyOf = (c: { repository: string; number: number }) =>
  `${c.repository.toLowerCase()}#${c.number}`;

async function searchPRs(
  token: string,
  query: string,
): Promise<
  { ok: true; hits: SearchHits } | { ok: false; result: FetchResult }
> {
  const key = `${tokenKey(token)}:${query}`;
  const cached = cacheGet(searchCache, key);
  if (cached) return { ok: true, hits: cached };

  const result = await githubFetch(
    `/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${MAX_CANDIDATES}`,
    token,
  );
  if (!result.ok) return { ok: false, result };
  const data = result.data as GithubSearchResponse | null;
  const candidates: Candidate[] = [];
  for (const it of data?.items ?? []) {
    const m =
      typeof it.repository_url === 'string'
        ? /\/repos\/([^/]+\/[^/]+)$/.exec(it.repository_url)
        : null;
    if (!m || typeof it.number !== 'number' || !it.pull_request) continue;
    candidates.push({
      repository: m[1],
      number: it.number,
      updatedAt: typeof it.updated_at === 'string' ? it.updated_at : '',
    });
  }
  const hits: SearchHits = {
    candidates,
    partial:
      data?.incomplete_results === true ||
      (typeof data?.total_count === 'number' &&
        data.total_count > candidates.length),
  };
  cacheSet(searchCache, SEARCH_CACHE_MAX, SEARCH_CACHE_TTL_MS, key, hits);
  return { ok: true, hits };
}

interface Enriched {
  title: string;
  html_url: string;
  author: string | null;
  statuses: InboxStatus[];
  comments: number;
  additions: number;
  deletions: number;
  requested_at: string | null;
}

interface GithubPRInbox {
  title?: unknown;
  html_url?: unknown;
  user?: { login?: unknown } | null;
  additions?: unknown;
  deletions?: unknown;
  comments?: unknown;
  review_comments?: unknown;
}

interface TimelineEvent {
  event?: unknown;
  created_at?: unknown;
  requested_reviewer?: { login?: unknown } | null;
}

const num = (v: unknown) => (typeof v === 'number' ? v : 0);

/** Latest `review_requested` event aimed at `login`; null if none seen. */
export function latestRequestTo(
  events: TimelineEvent[],
  login: string,
): string | null {
  let latest: string | null = null;
  for (const e of events) {
    if (e.event !== 'review_requested') continue;
    const who = e.requested_reviewer?.login;
    if (typeof who !== 'string' || who.toLowerCase() !== login.toLowerCase())
      continue;
    if (typeof e.created_at !== 'string') continue;
    if (latest === null || e.created_at > latest) latest = e.created_at;
  }
  return latest;
}

/** Statuses from each reviewer's latest decision; `['open']` if none. */
export function inboxStatuses(reviews: GithubReview[]): InboxStatus[] {
  const states = new Set(mapReviewers(reviews, []).map((r) => r.state));
  const out: InboxStatus[] = [];
  if (states.has('changes_requested')) out.push('changes_requested');
  if (states.has('approved')) out.push('approved');
  return out.length > 0 ? out : ['open'];
}

type EnrichOutcome =
  | { kind: 'ok'; value: Enriched }
  | { kind: 'gone' }
  | { kind: 'error'; result: FetchResult };

async function enrich(
  token: string,
  viewerLogin: string,
  c: Candidate,
): Promise<EnrichOutcome> {
  const key = `${tokenKey(token)}:${keyOf(c)}:${c.updatedAt}`;
  const cached = c.updatedAt ? cacheGet(enrichCache, key) : undefined;
  if (cached) return { kind: 'ok', value: cached };

  const [owner, repo] = c.repository.split('/');
  if (!isGithubName(owner) || !isGithubName(repo)) return { kind: 'gone' };
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const [details, reviews, timeline] = await Promise.all([
    githubFetch(`${base}/pulls/${c.number}`, token),
    githubFetchAll<GithubReview>(
      `${base}/pulls/${c.number}/reviews`,
      token,
      (d) => (Array.isArray(d) ? (d as GithubReview[]) : []),
    ),
    // Optional: only feeds `requested_at`, which may be null.
    githubFetchAll<TimelineEvent>(
      `${base}/issues/${c.number}/timeline`,
      token,
      (d) => (Array.isArray(d) ? (d as TimelineEvent[]) : []),
      TIMELINE_MAX_PAGES,
    ),
  ]);

  // Only token-wide failures (bad token, rate limit) abort the inbox. Any
  // other unreadable PR (404, a 403 from SAML SSO, a timeout, a 5xx) is
  // dropped and marks the inbox incomplete.
  const fatal = (r: FetchResult): EnrichOutcome =>
    r.status === 401 || isRateLimited(r)
      ? { kind: 'error', result: r }
      : { kind: 'gone' };
  if (!details.ok) return fatal(details);
  if (!reviews.ok) return fatal(reviews.result);

  const d = details.data as GithubPRInbox | null;
  const author = d?.user?.login;
  // A timeline cut off at the cap may have missed the latest request.
  const requested_at =
    timeline.ok && timeline.items.length < TIMELINE_CAP
      ? latestRequestTo(timeline.items, viewerLogin)
      : null;
  const value: Enriched = {
    title: typeof d?.title === 'string' ? d.title : '',
    html_url:
      typeof d?.html_url === 'string'
        ? d.html_url
        : `https://github.com/${c.repository}/pull/${c.number}`,
    author: typeof author === 'string' ? author : null,
    statuses: inboxStatuses(reviews.items),
    comments: num(d?.comments) + num(d?.review_comments),
    additions: num(d?.additions),
    deletions: num(d?.deletions),
    requested_at,
  };
  if (c.updatedAt) {
    cacheSet(enrichCache, ENRICH_CACHE_MAX, ENRICH_CACHE_TTL_MS, key, value);
  }
  return { kind: 'ok', value };
}

const compareItems = (a: InboxItem, b: InboxItem) => {
  if (a.requested_at !== b.requested_at) {
    if (a.requested_at === null) return 1;
    if (b.requested_at === null) return -1;
    return a.requested_at < b.requested_at ? 1 : -1;
  }
  const ra = a.repository.toLowerCase();
  const rb = b.repository.toLowerCase();
  if (ra !== rb) return ra < rb ? -1 : 1;
  return b.number - a.number;
};

const intParam = (
  raw: string | undefined,
  def: number,
  min: number,
  max: number,
) => {
  if (raw === undefined) return def;
  if (!/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
};

export const inboxRoutes = new Hono().get('/inbox', async (c) => {
  const auth = bearerToken(c);
  if (auth.error) return auth.error;
  const { token } = auth;

  const status = c.req.query('status');
  if (status !== undefined && !STATUSES.includes(status as InboxStatus)) {
    return c.json(
      { error: `Invalid status; use one of ${STATUSES.join(', ')}` },
      400,
    );
  }
  const repoParam = c.req.query('repo');
  if (repoParam !== undefined) {
    const parts = repoParam.split('/');
    if (
      parts.length !== 2 ||
      !isGithubName(parts[0]) ||
      !isGithubName(parts[1])
    ) {
      return c.json({ error: 'Invalid repo; use owner/name' }, 400);
    }
  }
  const q = c.req.query('q')?.trim() ?? '';
  if (q.length > MAX_Q_LENGTH) {
    return c.json({ error: `q is limited to ${MAX_Q_LENGTH} characters` }, 400);
  }
  if (SCOPE_BREAKING.test(q) || hasOperator(q)) {
    return c.json(
      {
        error:
          'q may not use OR/AND/NOT, parentheses, or the is:, type:, state:, archived: and review qualifiers',
      },
      400,
    );
  }
  const groupBy = c.req.query('group_by') ?? 'none';
  if (groupBy !== 'none' && groupBy !== 'repository') {
    return c.json({ error: 'Invalid group_by; use none or repository' }, 400);
  }
  const page = intParam(c.req.query('page'), 1, 1, 1_000_000);
  const perPage = intParam(
    c.req.query('per_page'),
    DEFAULT_PER_PAGE,
    1,
    MAX_PER_PAGE,
  );
  if (page === null || perPage === null) {
    return c.json(
      { error: `Invalid page or per_page (per_page 1-${MAX_PER_PAGE})` },
      400,
    );
  }

  const [scope, viewer, matched] = await Promise.all([
    searchPRs(token, SCOPE),
    fetchViewer(token),
    q ? searchPRs(token, `${SCOPE} ${q}`) : Promise.resolve(null),
  ]);
  const searchFailure = (
    r: { ok: false; result: FetchResult } | null,
  ): FetchResult | null => (r && !r.ok ? r.result : null);
  const failure =
    searchFailure(scope.ok ? null : scope) ??
    searchFailure(matched && !matched.ok ? matched : null) ??
    (viewer.ok ? null : viewer);
  if (failure) {
    if (failure.status === 422) {
      return c.json(
        { error: githubErrorMessage(failure.data) ?? 'Invalid search query' },
        400,
      );
    }
    if (failure.status === 404)
      return c.json({ error: 'GitHub API error' }, 502);
    return upstreamError(c, failure, 'inbox');
  }
  if (!scope.ok || !viewer.ok) throw new Error('unreachable');

  // Enrich the whole inbox (counts need it), a few PRs at a time.
  const candidates = scope.hits.candidates;
  const outcomes: EnrichOutcome[] = new Array(candidates.length);
  let next = 0;
  let failed: FetchResult | null = null;
  const worker = async () => {
    while (!failed && next < candidates.length) {
      const i = next++;
      const out = await enrich(token, viewer.viewer.login, candidates[i]);
      outcomes[i] = out;
      if (out.kind === 'error') failed = out.result;
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(ENRICH_CONCURRENCY, candidates.length) },
      worker,
    ),
  );
  if (failed) return upstreamError(c, failed, 'inbox');

  let complete = !scope.hits.partial;
  const all: InboxItem[] = [];
  candidates.forEach((cand, i) => {
    const out = outcomes[i];
    if (out.kind !== 'ok') {
      complete = false;
      return;
    }
    all.push({
      repository: cand.repository,
      number: cand.number,
      ...out.value,
    });
  });
  all.sort(compareItems);

  const counts = {
    pending: all.length,
    status: { open: 0, changes_requested: 0, approved: 0 },
  };
  const repoCounts = new Map<string, InboxRepository>();
  for (const it of all) {
    for (const s of it.statuses) counts.status[s]++;
    const k = it.repository.toLowerCase();
    const r = repoCounts.get(k);
    if (r) r.count++;
    else repoCounts.set(k, { name: it.repository, count: 1 });
  }
  const repositories = [...repoCounts.values()].sort((a, b) =>
    a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1,
  );

  const matchedKeys = matched?.ok
    ? new Set(matched.hits.candidates.map(keyOf))
    : null;
  if (matched?.ok && matched.hits.partial) complete = false;
  const repoFilter = repoParam?.toLowerCase();
  const filtered = all.filter(
    (it) =>
      (!status || it.statuses.includes(status as InboxStatus)) &&
      (!repoFilter || it.repository.toLowerCase() === repoFilter) &&
      (!matchedKeys || matchedKeys.has(keyOf(it))),
  );

  const total = filtered.length;
  const slice = filtered.slice((page - 1) * perPage, page * perPage);
  const base = {
    counts,
    repositories,
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: Math.ceil(total / perPage),
    },
    complete,
  };

  if (groupBy === 'repository') {
    const groups = new Map<string, InboxGroup>();
    for (const it of slice) {
      const k = it.repository.toLowerCase();
      const g = groups.get(k);
      if (g) g.items.push(it);
      else groups.set(k, { repository: it.repository, items: [it] });
    }
    return c.json<InboxResponse>({
      ...base,
      group_by: 'repository',
      groups: [...groups.values()],
    });
  }
  return c.json<InboxResponse>({ ...base, group_by: 'none', items: slice });
});
