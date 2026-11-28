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

const MATCHED_FIELDS = `issueCount
    nodes { ... on PullRequest { number repository { nameWithOwner } } }`;

// `latestOpinionatedReviews`: each reviewer's latest APPROVED / CHANGES_REQUESTED
// / DISMISSED review, so a later COMMENTED review doesn't erase a decision and
// a dismissed one no longer counts.
export const INBOX_QUERY = `query Inbox($scope: String!, $match: String!, $hasMatch: Boolean!) {
  viewer { login }
  rateLimit { cost remaining resetAt }
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
          totalCount
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
    ${MATCHED_FIELDS}
  }
}`;

/** A `q` miss with a warm scope reads only the hits: no per-PR metadata. */
export const MATCH_QUERY = `query InboxMatch($match: String!) {
  matched: search(query: $match, type: ISSUE, first: ${MAX_CANDIDATES}) {
    ${MATCHED_FIELDS}
  }
}`;

/** The exact request `GET /inbox` sends for a `q` (shared with the measure script). */
export const inboxRequest = (q: string) => ({
  query: INBOX_QUERY,
  variables: {
    scope: SCOPE,
    match: q ? `${SCOPE} ${q}` : '',
    hasMatch: q !== '',
  },
});

// Cache of error-free reads: SHA-256 of the token (never the token) → entry,
// so one caller can't be served another's results. A token holds
// - one `scope` read (the enriched PRs, independent of `q`), and
// - up to INBOX_CACHE_PER_TOKEN_MAX `q` → match entries (just the hit keys),
//   each tied to the scope read it was made against: when that scope is
//   refreshed, evicted or expired its matches stop applying and are dropped.
// So `q` churn re-reads only the cheap hit lists, never the whole inbox.
// Entries expire INBOX_CACHE_TTL_MS after they were read (a hit doesn't
// extend that). At most INBOX_CACHE_MAX entries overall; room for a NEW entry
// drops expired entries, then the oldest match of the least recently used
// other token (its scope once it has none). Replacing an entry evicts nothing
// else. Map order = recency. In memory, per isolate/process.
interface ScopeSnap {
  viewer: string;
  items: Snapshot['items'];
  /** More matches than were read, a node was unreadable, or a list was cut. */
  partial: boolean;
}
interface MatchSnap {
  keys: Set<string>;
  /** More hits than were read, or a hit was unreadable. */
  partial: boolean;
}
interface TokenCache {
  scope?: { value: ScopeSnap; expires: number };
  matches: Map<string, MatchSnap & { scope: ScopeSnap; expires: number }>;
}
const cache = new Map<string, TokenCache>();

/** Tests: forget cached inbox reads. */
export function clearInboxCache() {
  cache.clear();
}

const sizeOf = (tc: TokenCache) => (tc.scope ? 1 : 0) + tc.matches.size;

/** Tests: number of cached entries across all tokens. */
export function inboxCacheSize() {
  let n = 0;
  for (const tc of cache.values()) n += sizeOf(tc);
  return n;
}

const touch = (token: string, tc: TokenCache) => {
  cache.delete(token);
  cache.set(token, tc); // token becomes most recently used
};

function dropExpired(token: string, tc: TokenCache, now: number) {
  if (tc.scope && tc.scope.expires <= now) {
    tc.scope = undefined;
    tc.matches.clear(); // matches of a gone scope no longer apply
  }
  for (const [q, e] of tc.matches) if (e.expires <= now) tc.matches.delete(q);
  if (sizeOf(tc) === 0) cache.delete(token);
}

function makeRoom(except: string) {
  if (inboxCacheSize() < INBOX_CACHE_MAX) return;
  const now = Date.now();
  for (const [t, tc] of cache) dropExpired(t, tc, now);
  if (inboxCacheSize() < INBOX_CACHE_MAX) return;
  for (const [t, tc] of cache) {
    if (t === except) continue;
    const oldest = tc.matches.keys().next().value;
    if (oldest !== undefined) tc.matches.delete(oldest);
    else cache.delete(t); // only its scope was left
    return;
  }
}

function cacheGetScope(token: string): ScopeSnap | undefined {
  const tc = cache.get(token);
  if (!tc) return undefined;
  dropExpired(token, tc, Date.now());
  if (!tc.scope) return undefined;
  touch(token, tc);
  return tc.scope.value;
}

function cacheGetMatch(
  token: string,
  q: string,
  scope: ScopeSnap,
): MatchSnap | undefined {
  const tc = cache.get(token);
  const hit = tc?.matches.get(q);
  if (!tc || !hit) return undefined;
  tc.matches.delete(q);
  if (hit.scope !== scope || hit.expires <= Date.now()) return undefined;
  tc.matches.set(q, hit); // most recently used
  touch(token, tc);
  return hit;
}

function cacheSetScope(token: string, value: ScopeSnap) {
  const tc: TokenCache = cache.get(token) ?? { matches: new Map() };
  tc.matches.clear(); // they were made against the old scope
  if (!tc.scope) makeRoom(token);
  tc.scope = { value, expires: Date.now() + INBOX_CACHE_TTL_MS };
  touch(token, tc);
}

function cacheSetMatch(
  token: string,
  q: string,
  scope: ScopeSnap,
  match: MatchSnap,
) {
  const tc = cache.get(token);
  // Only against the scope still cached: an older generation can't compose.
  if (!tc || tc.scope?.value !== scope) return;
  if (tc.matches.has(q)) tc.matches.delete(q);
  else {
    if (tc.matches.size >= INBOX_CACHE_PER_TOKEN_MAX) {
      const oldest = tc.matches.keys().next().value;
      if (oldest !== undefined) tc.matches.delete(oldest);
    }
    makeRoom(token);
    if (tc.scope?.value !== scope) return;
  }
  tc.matches.set(q, {
    ...match,
    scope,
    expires: Math.min(Date.now() + INBOX_CACHE_TTL_MS, tc.scope.expires),
  });
  touch(token, tc);
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

/** A PR node → an item; `truncated` when its review list was cut short, or the request window was cut without the viewer's request in it. */
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
  const timeline = obj(n.timelineItems);
  const events = list(timeline?.nodes) as RequestEvent[];
  const author = obj(n.author)?.login;
  // Only a cut review list changes what's reported (statuses). A cut thread
  // list just makes `comments` a lower bound, so it doesn't mark the inbox
  // incomplete: one big PR would otherwise do that for as long as it's listed.
  const requestedAt = latestRequestTo(events, viewerLogin);
  // The viewer's request may be older than the newest events read: then
  // `requested_at` is unknown, not absent. Finding it in the window is exact.
  const requestWindowCut =
    requestedAt === null && num(timeline?.totalCount) > events.length;
  const truncated =
    num(reviews?.totalCount) > reviewNodes.length || requestWindowCut;

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
      requested_at: requestedAt,
    },
  };
}

type Loaded =
  | { ok: true; snapshot: Snapshot }
  | { ok: false; result: FetchResult };

const compose = (scope: ScopeSnap, match: MatchSnap | null): Snapshot => ({
  viewer: scope.viewer,
  items: scope.items,
  matchedKeys: match?.keys ?? null,
  partial: scope.partial || (match?.partial ?? false),
});

function parseScope(
  data: Record<string, unknown>,
  hadErrors: boolean,
): ScopeSnap | null {
  const login = obj(data.viewer)?.login;
  const scope = obj(data.scope);
  if (typeof login !== 'string' || !scope) return null;
  const nodes = list(scope.nodes);
  const items: Snapshot['items'] = [];
  let partial = hadErrors || num(scope.issueCount) > nodes.length;
  for (const node of nodes) {
    const pr = parsePR(node, login);
    if (!pr) partial = true;
    else {
      items.push(pr.item);
      if (pr.truncated) partial = true;
    }
  }
  return { viewer: login, items, partial };
}

function parseMatch(data: unknown, hadErrors: boolean): MatchSnap | null {
  const matched = obj(data);
  if (!matched) return null;
  const nodes = list(matched.nodes);
  const keys = new Set<string>();
  let partial = hadErrors || num(matched.issueCount) > nodes.length;
  for (const node of nodes) {
    const n = obj(node);
    const repo = obj(n?.repository)?.nameWithOwner;
    if (typeof repo === 'string' && typeof n?.number === 'number')
      keys.add(keyOf({ repository: repo, number: n.number }));
    else partial = true;
  }
  return { keys, partial };
}

/**
 * The inbox for a `q`. The enriched scope read is cached per token regardless
 * of `q`; a `q` miss with a warm scope reads only the hit list. A cold read is
 * one request. A response with errors but data is usable but partial: it is
 * flagged and never cached, so the next load re-reads it. Scope and match
 * completeness are independent: a partial match never taints the scope.
 */
async function loadInbox(token: string, q: string): Promise<Loaded> {
  const hashed = await tokenHash(token);
  const cachedScope = cacheGetScope(hashed);

  if (cachedScope) {
    if (!q) return { ok: true, snapshot: compose(cachedScope, null) };
    const hit = cacheGetMatch(hashed, q, cachedScope);
    if (hit) return { ok: true, snapshot: compose(cachedScope, hit) };
    const res = await githubGraphQL(token, MATCH_QUERY, {
      match: `${SCOPE} ${q}`,
    });
    if (!res.ok) return res;
    const match = parseMatch(res.data.matched, res.errors.length > 0);
    if (!match) return { ok: false, result: failure(502) };
    if (res.errors.length === 0) cacheSetMatch(hashed, q, cachedScope, match);
    return { ok: true, snapshot: compose(cachedScope, match) };
  }

  const req = inboxRequest(q);
  const res = await githubGraphQL(token, req.query, req.variables);
  if (!res.ok) return res;
  const hadErrors = res.errors.length > 0;
  const scope = parseScope(res.data, hadErrors);
  if (!scope) {
    // Not a readable inbox: fail rather than look like an empty one.
    return { ok: false, result: failure(502) };
  }
  let match: MatchSnap | null = null;
  if (q) {
    match = parseMatch(res.data.matched, hadErrors);
    if (!match) return { ok: false, result: failure(502) };
  }
  if (!hadErrors) {
    cacheSetScope(hashed, scope);
    if (match) cacheSetMatch(hashed, q, scope, match);
  }
  return { ok: true, snapshot: compose(scope, match) };
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
