import type { InboxResponse } from '@lythium/api/types';
import { redirect } from '@sveltejs/kit';
import {
  type InboxFailure,
  inboxApiParams,
  inboxHref,
  parseInboxQuery,
} from '#lib/inbox.ts';
import { API_URL } from '$app/env/private';
import type { PageServerLoad } from './$types';

function retryAfterSeconds(header: string | null): number | null {
  const seconds = Number.parseInt(header ?? '', 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

async function apiMessage(res: Response): Promise<string | null> {
  const body = await res.json().catch(() => null);
  return typeof body?.error === 'string' ? body.error : null;
}

export const load: PageServerLoad = async ({ url, cookies, fetch }) => {
  const query = parseInboxQuery(url.searchParams);
  const token = cookies.get('token');
  if (!token) {
    const back = inboxHref(query, { page: query.page });
    redirect(302, `/auth/github/login?redirectTo=${encodeURIComponent(back)}`);
  }

  const fail = (failure: InboxFailure) => ({
    query,
    inbox: null,
    failure,
  });

  let res: Response;
  try {
    res = await fetch(`${API_URL}/inbox?${inboxApiParams(query)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return fail({
      kind: 'unavailable',
      message: 'The review inbox could not be reached.',
    });
  }

  if (res.ok) {
    const inbox: InboxResponse = await res.json();
    return { query, inbox, failure: null };
  }

  if (res.status === 401 || res.status === 403) {
    return fail({
      kind: 'auth',
      message: 'Your GitHub session has expired. Sign in again to continue.',
    });
  }
  if (res.status === 400) {
    return fail({
      kind: 'invalid',
      message: (await apiMessage(res)) ?? 'That search is not supported.',
    });
  }
  if (res.status === 429) {
    return fail({
      kind: 'rate_limit',
      message: 'GitHub is rate limiting requests.',
      retryAfter: retryAfterSeconds(res.headers.get('retry-after')),
    });
  }
  return fail({
    kind: 'unavailable',
    message:
      res.status === 504
        ? 'GitHub took too long to respond.'
        : 'The review inbox is unavailable right now.',
  });
};
