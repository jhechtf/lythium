import { vi } from 'vitest';

/**
 * Test helpers for guided-review routes: a fake GitHub that answers the
 * lookups those routes make (PR, viewer, PR files). Not used at runtime.
 */

export const SHA = 'a'.repeat(40);
export const NEW_SHA = 'b'.repeat(40);
export const AUTHOR = 1;
export const REVIEWER = 2;

export interface FakeGithub {
  headSha: string;
  authorId: number;
  /** Viewer id per token. */
  viewers: Record<string, number>;
  /** Callers (by token) with push access. */
  pushers: string[];
  files: { filename: string; status: string; patch?: string }[];
  /** Force a status for a path prefix, e.g. `{ '/user': 401 }`. */
  failures: Record<string, number>;
}

export function fakeGithub(overrides: Partial<FakeGithub> = {}) {
  const gh: FakeGithub = {
    headSha: SHA,
    authorId: AUTHOR,
    viewers: { author: AUTHOR, reviewer: REVIEWER },
    pushers: [],
    files: [
      {
        filename: 'api/a.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-a\n+b',
      },
      { filename: 'api/b.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+b' },
      { filename: 'web/c.svelte', status: 'modified' },
      { filename: 'old.ts', status: 'removed' },
    ],
    failures: {},
    ...overrides,
  };
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const token = (
      (init?.headers as Record<string, string>)?.Authorization ?? ''
    ).replace('Bearer ', '');
    for (const [prefix, status] of Object.entries(gh.failures)) {
      if (url.pathname.startsWith(prefix)) {
        return new Response('fail', { status });
      }
    }
    const json = (v: unknown) => new Response(JSON.stringify(v));
    if (url.pathname === '/user') {
      const id = gh.viewers[token];
      return id === undefined
        ? new Response('bad', { status: 401 })
        : json({ id, login: token });
    }
    const files = url.pathname.match(
      /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/files$/,
    );
    if (files) {
      const page = Number(url.searchParams.get('page') ?? 1);
      const per = Number(url.searchParams.get('per_page') ?? 30);
      return json(gh.files.slice((page - 1) * per, page * per));
    }
    if (/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(url.pathname)) {
      return json({
        head: { sha: gh.headSha },
        user: { id: gh.authorId },
        base: {
          repo: { permissions: { push: gh.pushers.includes(token) } },
        },
      });
    }
    return new Response('not stubbed', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { gh, fetchMock };
}

export const PR_URL = '/repos/github/o/r/pr/7';

/** Request options for a JSON call as the given token. */
export function as(token: string, method = 'GET', body?: unknown): RequestInit {
  return {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  };
}
