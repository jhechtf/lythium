import { Hono } from 'hono';
import {
  type FetchResult,
  githubGraphQL,
  isGithubName,
  upstreamError,
} from './github.ts';
import { bearerToken } from './route-params.ts';
import { tokenHash } from './token-hash.ts';
import type {
  InboxGroup,
  InboxItem,
  InboxRepository,
  InboxResponse,
  InboxStatus,
} from './types.ts';

/**
 * Review inbox (LYT-59): PRs awaiting the caller's review, with the caller's
 * token, read with ONE GitHub GraphQL request (search + per-PR metadata +
 * viewer), so the number of outbound calls doesn't grow with the inbox. REST
 * fan-out (details, reviews and timeline per PR) cost 300-400 subrequests for
 * 100 PRs, past what a Workers invocation allows.
 *
 * Decisions:
 * - The candidate set is always the scope search. A `q` is a second search
 *   (scope + q) in the same request whose hits are intersected with it, so no
 *   `q` can widen the inbox. `q` is GitHub search syntax, but qualifiers and
 *   operators that could change the scope (`is:`, `review-requested:`, `OR`,
 *   parentheses…) → 400.
 * - Counts, pending total and repositories cover the whole inbox, ignoring
 *   filters and paging.
 * - At most `MAX_CANDIDATES` PRs are read (one search page); anything beyond
 *   that, a node GitHub couldn't return, or a list cut at its bound sets
 *   `complete: false`. A failed GraphQL read is an error, never an empty inbox.
 */

export const MAX_CANDIDATES = 100;
const DEFAULT_PER_PAGE = 25;
const MAX_PER_PAGE = 100;
const MAX_Q_LENGTH = 256;
// Bounds on the per-PR lists (one page each, no further paging). Node count
// stays far below GitHub's 500k-node GraphQL limit:
// 100 PRs × (100 reviews + 100 threads + 20 events) ≈ 22k.
const REVIEWS_BOUND = 100;
const THREADS_BOUND = 100;
const REQUEST_EVENTS_BOUND = 20;

// Only a fully-read response is cached; this also bounds how stale it gets.
export const INBOX_CACHE_TTL_MS = 30_000;
export const INBOX_CACHE_MAX = 200;
// Distinct `q` values one token may keep cached at once.
export const INBOX_CACHE_PER_TOKEN_MAX = 5;

const STATUSES: readonly InboxStatus[] = [
  'open',
  'changes_requested',
  'approved',
];

const SCOPE =
  'is:pr is:open archived:false review-requested:@me sort:updated-desc';

// Anything that could turn the scope into something else.
const SCOPE_BREAKING =
  /(^|[\s"'(])-?(is|type|state|review-requested|user-review-requested|team-review-requested|reviewed-by|review|archived|sort):/i;
const hasOperator = (q: string) =>
  /(^|\s)(OR|AND|NOT)(\s|$)/.test(q) || /[()]/.test(q);

// `latestOpinionatedReviews`: each reviewer's latest APPROVED / CHANGES_REQUESTED
// / DISMISSED review, so a later COMMENTED review doesn't erase a decision and
// a dismissed one no longer counts.
const QUERY = `query Inbox($scope: String!, $match: String!, $hasMatch: Boolean!) {
  viewer { login }
  scope: search(query: $scope, type: ISSUE, first: ${MAX_CANDIDATES}) {
    issueCount
    nodes {
      ... on PullRequest {
        number
        title
        url
        additions
        deletions
        author { login }
        repository { nameWithOwner }
        comments { totalCount }
        reviewThreads(first: ${THREADS_BOUND}) {
          totalCount
          nodes { comments { totalCount } }
        }
        latestOpinionatedReviews(first: ${REVIEWS_BOUND}) {
          totalCount
          nodes { state }
        }
        timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: ${REQUEST_EVENTS_BOUND}) {
          nodes {
            ... on ReviewRequestedEvent {
              createdAt
              requestedReviewer { ... on User { login } }
            }
          }
        }
      }
    }
  }
  matched: search(query: $match, type: ISSUE, first: ${MAX_CANDIDATES}) @include(if: $hasMatch) {
    issueCount
    nodes { ... on PullRequest { number repository { nameWithOwner } } }
  }
}`;

// Cache of fully-read inboxes: SHA-256 of the token (never the token) → `q` →
// entry, so one caller can't be served another's results. Policy:
// - at most INBOX_CACHE_PER_TOKEN_MAX entries per token (oldest-used goes), so
//   one token churning through `q` values only evicts its own entries;
// - at most INBOX_CACHE_MAX entries overall; a NEW key at the limit first
//   drops expired entries, then the oldest entry of the least recently used
//   token. Replacing an existing key never evicts anything else.
// Map order = recency. In memory, per isolate/process.
interface CacheEntry {
  value: Snapshot;
  expires: number;
}
const cache = new Map<string, Map<string, CacheEntry>>();

/** Tests: forget cached inbox reads. */
export function clearInboxCache() {
  cache.clear();
}

/** Tests: number of cached entries across all tokens. */
export function inboxCacheSize() {
  let n = 0;
  for (const m of cache.values()) n += m.size;
  return n;
}

function cacheGet(token: string, q: string): Snapshot | undefined {
  const m = cache.get(token);
  const hit = m?.get(q);
  if (!m || !hit) return undefined;
  m.delete(q);
  if (hit.expires <= Date.now()) {
    if (m.size === 0) cache.delete(token);
    return undefined;
  }
  m.set(q, hit); // most recently used
  return hit.value;
}

function evictForNewEntry() {
  const now = Date.now();
  for (const [t, m] of cache) {
    for (const [q, e] of m) if (e.expires <= now) m.delete(q);
    if (m.size === 0) cache.delete(t);
  }
  if (inboxCacheSize() < INBOX_CACHE_MAX) return;
  const [t, m] = cache.entries().next().value ?? [];
  if (!t || !m) return;
  const oldest = m.keys().next().value;
  if (oldest !== undefined) m.delete(oldest);
  if (m.size === 0) cache.delete(t);
}

function cacheSet(token: string, q: string, value: Snapshot) {
  const m = cache.get(token) ?? new Map<string, CacheEntry>();
  if (m.has(q)) m.delete(q);
  else {
    if (m.size >= INBOX_CACHE_PER_TOKEN_MAX) {
      const oldest = m.keys().next().value;
      if (oldest !== undefined) m.delete(oldest);
    }
    if (inboxCacheSize() >= INBOX_CACHE_MAX) evictForNewEntry();
  }
  m.set(q, { value, expires: Date.now() + INBOX_CACHE_TTL_MS });
  cache.delete(token);
  cache.set(token, m); // token becomes most recently used
}

type Enriched = Omit<InboxItem, 'repository' | 'number'>;

interface Snapshot {
  viewer: string;
  items: (Pick<InboxItem, 'repository' | 'number'> & Enriched)[];
  /** Keys of the `q` search's hits; null without a `q`. */
  matchedKeys: Set<string> | null;
  /** More matches than were read, a node was unreadable, or a list was cut. */
  partial: boolean;
}

const keyOf = (c: { repository: string; number: number }) =>
  `${c.repository.toLowerCase()}#${c.number}`;

interface RequestEvent {
  createdAt?: unknown;
  requestedReviewer?: { login?: unknown } | null;
}

const num = (v: unknown) => (typeof v === 'number' ? v : 0);
const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Latest review request aimed at `login` (a user; team requests and deleted
 * reviewers have no login), from the bounded newest events; null if none.
 */
export function latestRequestTo(
  events: RequestEvent[],
  login: string,
): string | null {
  let latest: string | null = null;
  for (const e of events) {
    const who = e?.requestedReviewer?.login;
    if (typeof who !== 'string' || who.toLowerCase() !== login.toLowerCase())
      continue;
    if (typeof e.createdAt !== 'string') continue;
    if (latest === null || e.createdAt > latest) latest = e.createdAt;
  }
  return latest;
}

/**
 * Statuses from each reviewer's latest decision (GitHub's
 * `latestOpinionatedReviews`, one per reviewer); `['open']` if none holds.
 */
export function inboxStatuses(latest: { state?: unknown }[]): InboxStatus[] {
  const states = new Set(latest.map((r) => r?.state));
  const out: InboxStatus[] = [];
  if (states.has('CHANGES_REQUESTED')) out.push('changes_requested');
  if (states.has('APPROVED')) out.push('approved');
  return out.length > 0 ? out : ['open'];
}

/** A PR node → an item; `truncated` when a bounded list was cut short. */
function parsePR(
  node: unknown,
  viewerLogin: string,
): { item: Snapshot['items'][number]; truncated: boolean } | null {
  const n = obj(node);
  const repository = obj(n?.repository)?.nameWithOwner;
  if (!n || typeof repository !== 'string' || typeof n.number !== 'number')
    return null;
  if (!repository.split('/').every(isGithubName)) return null;

  const threads = obj(n.reviewThreads);
  const threadNodes = list(threads?.nodes);
  const reviews = obj(n.latestOpinionatedReviews);
  const reviewNodes = list(reviews?.nodes) as { state?: unknown }[];
  const events = list(obj(n.timelineItems)?.nodes) as RequestEvent[];
  const author = obj(n.author)?.login;
  const truncated =
    num(threads?.totalCount) > threadNodes.length ||
    num(reviews?.totalCount) > reviewNodes.length;

  return {
    truncated,
    item: {
      repository,
      number: n.number,
      title: typeof n.title === 'string' ? n.title : '',
      html_url:
        typeof n.url === 'string'
          ? n.url
          : `https://github.com/${repository}/pull/${n.number}`,
      author: typeof author === 'string' ? author : null,
      statuses: inboxStatuses(reviewNodes),
      // Issue comments + inline review comments (threads' comments).
      comments:
        num(obj(n.comments)?.totalCount) +
        threadNodes.reduce<number>(
          (sum, t) => sum + num(obj(obj(t)?.comments)?.totalCount),
          0,
        ),
      additions: num(n.additions),
      deletions: num(n.deletions),
      requested_at: latestRequestTo(events, viewerLogin),
    },
  };
}

/**
 * One GraphQL request for the whole inbox. A response with errors but data is
 * usable but partial: it is flagged and never cached, so the next load
 * re-reads it.
 */
async function loadInbox(
  token: string,
  q: string,
): Promise<
  { ok: true; snapshot: Snapshot } | { ok: false; result: FetchResult }
> {
  const hashed = await tokenHash(token);
  const cached = cacheGet(hashed, q);
  if (cached) return { ok: true, snapshot: cached };

  const res = await githubGraphQL(token, QUERY, {
    scope: SCOPE,
    match: q ? `${SCOPE} ${q}` : '',
    hasMatch: q !== '',
  });
  if (!res.ok) return res;

  const login = obj(res.data.viewer)?.login;
  const scope = obj(res.data.scope);
  if (typeof login !== 'string' || !scope) {
    // Not a readable inbox: fail rather than look like an empty one.
    return { ok: false, result: failure(502) };
  }
  const nodes = list(scope.nodes);
  const items: Snapshot['items'] = [];
  let partial = res.errors.length > 0 || num(scope.issueCount) > nodes.length;
  for (const node of nodes) {
    const pr = parsePR(node, login);
    if (!pr) partial = true;
    else {
      items.push(pr.item);
      if (pr.truncated) partial = true;
    }
  }

  let matchedKeys: Set<string> | null = null;
  if (q) {
    const matched = obj(res.data.matched);
    if (!matched) return { ok: false, result: failure(502) };
    const mNodes = list(matched.nodes);
    matchedKeys = new Set();
    for (const node of mNodes) {
      const n = obj(node);
      const repo = obj(n?.repository)?.nameWithOwner;
      if (typeof repo === 'string' && typeof n?.number === 'number')
        matchedKeys.add(keyOf({ repository: repo, number: n.number }));
      else partial = true;
    }
    if (num(matched.issueCount) > mNodes.length) partial = true;
  }

  const snapshot: Snapshot = { viewer: login, items, matchedKeys, partial };
  if (res.errors.length === 0) cacheSet(hashed, q, snapshot);
  return { ok: true, snapshot };
}

const failure = (status: number): FetchResult => ({
  ok: false,
  status,
  data: null,
  headers: new Headers(),
});

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

  const loaded = await loadInbox(token, q);
  if (!loaded.ok) {
    // A search GitHub rejects or a missing resource is our upstream's fault.
    if (loaded.result.status === 404 || loaded.result.status === 422)
      return c.json({ error: 'GitHub API error' }, 502);
    return upstreamError(c, loaded.result, 'inbox');
  }
  const { snapshot } = loaded;
  const complete = !snapshot.partial;
  const all = [...snapshot.items];
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

  const { matchedKeys } = snapshot;
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
