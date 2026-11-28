import type { InboxGroupBy, InboxStatus } from '@lythium/api/types';

export const INBOX_STATUSES: readonly InboxStatus[] = [
  'open',
  'changes_requested',
  'approved',
];

export const STATUS_LABELS: Record<InboxStatus, string> = {
  open: 'Open',
  changes_requested: 'Changes requested',
  approved: 'Approved',
};

/** The URL-backed inbox state. Everything here comes from the query string. */
export interface InboxQuery {
  status: InboxStatus | null;
  repo: string | null;
  q: string;
  group: InboxGroupBy;
  page: number;
}

/** Longest search the API accepts; longer input is cut rather than rejected. */
const MAX_Q = 256;

/** Reads the inbox state from a URL, dropping anything unrecognised. */
export function parseInboxQuery(params: URLSearchParams): InboxQuery {
  const status = params.get('status');
  const repo = params.get('repo')?.trim();
  const page = Number.parseInt(params.get('page') ?? '', 10);
  return {
    status: INBOX_STATUSES.includes(status as InboxStatus)
      ? (status as InboxStatus)
      : null,
    repo: repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null,
    q: (params.get('q') ?? '').trim().slice(0, MAX_Q),
    group: params.get('group_by') === 'repository' ? 'repository' : 'none',
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

/**
 * Builds the page's own query string for `query` with `changes` applied.
 * Defaults are omitted. Changing anything but the page resets the page.
 */
export function inboxHref(
  query: InboxQuery,
  changes: Partial<InboxQuery> = {},
): string {
  const next = { ...query, ...changes };
  if (!('page' in changes)) next.page = 1;
  const params = new URLSearchParams();
  if (next.status) params.set('status', next.status);
  if (next.repo) params.set('repo', next.repo);
  if (next.q) params.set('q', next.q);
  if (next.group !== 'none') params.set('group_by', next.group);
  if (next.page > 1) params.set('page', String(next.page));
  const qs = params.toString();
  return qs ? `/?${qs}` : '/';
}

/** The API request for a query. Only allowlisted values are forwarded. */
export function inboxApiParams(query: InboxQuery): URLSearchParams {
  const params = new URLSearchParams({
    group_by: query.group,
    page: String(query.page),
  });
  if (query.status) params.set('status', query.status);
  if (query.repo) params.set('repo', query.repo);
  if (query.q) params.set('q', query.q);
  return params;
}

export function prHref(repository: string, number: number): string {
  const [owner, name] = repository.split('/');
  return `/pr/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${number}`;
}

const UNITS: [limit: number, seconds: number, suffix: string][] = [
  [60, 1, 's'],
  [3600, 60, 'm'],
  [86400, 3600, 'h'],
  [86400 * 30, 86400, 'd'],
  [86400 * 365, 86400 * 30, 'mo'],
];

/** Compact age like the design mocks ("2h ago"); null when missing or invalid. */
export function relativeTime(
  iso: string | null,
  now: number = Date.now(),
): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const diff = Math.max(0, Math.round((now - then) / 1000));
  if (diff < 1) return 'just now';
  for (const [limit, seconds, suffix] of UNITS) {
    if (diff < limit) return `${Math.floor(diff / seconds)}${suffix} ago`;
  }
  return `${Math.floor(diff / (86400 * 365))}y ago`;
}

/** What went wrong loading the inbox, safe to show to the user. */
export type InboxFailure =
  | { kind: 'auth'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'rate_limit'; message: string; retryAfter: number | null }
  | { kind: 'unavailable'; message: string };
