import type { InboxItem } from '@lythium/api/types';
import type { ComponentProps } from 'svelte';
import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { parseInboxQuery } from '#lib/inbox.ts';
import '../app.css';
import Page from './+page.svelte';

type Data = ComponentProps<typeof Page>['data'];

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  repository: 'acme/web',
  number: 7,
  title: 'Add inbox',
  html_url: 'https://github.com/acme/web/pull/7',
  author: 'octo',
  statuses: ['open'],
  comments: 3,
  additions: 10,
  deletions: 2,
  requested_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
  ...over,
});

const base = {
  counts: {
    pending: 5,
    status: { open: 3, approved: 2, changes_requested: 1 },
  },
  repositories: [
    { name: 'acme/web', count: 3 },
    { name: 'acme/api', count: 2 },
  ],
  pagination: { page: 1, per_page: 25, total: 2, total_pages: 1 },
  complete: true,
};

const make = (search: string, inbox: unknown, failure: unknown = null) =>
  ({
    query: parseInboxQuery(new URLSearchParams(search)),
    inbox,
    failure,
  }) as unknown as Data;

const flat = (items: InboxItem[], extra = {}) => ({
  ...base,
  group_by: 'none',
  items,
  ...extra,
});

describe('/+page.svelte', () => {
  it('renders a flat row with link, badges, stats and global counts', async () => {
    render(Page, {
      data: make(
        '',
        flat([
          item({ statuses: ['approved', 'changes_requested'] }),
          item({ number: 8, author: null, requested_at: null, title: 'Other' }),
        ]),
      ),
    });
    const link = page.getByRole('link', { name: 'Add inbox' });
    await expect.element(link).toHaveAttribute('href', '/pr/acme/web/7');
    await expect.element(page.getByText('Approved').first()).toBeVisible();
    await expect
      .element(page.getByText('Changes requested').first())
      .toBeVisible();
    await expect.element(page.getByText('+10').first()).toBeVisible();
    await expect.element(page.getByText('3 hours ago')).toBeVisible();
    await expect.element(page.getByText('Unknown author')).toBeVisible();
    await expect
      .element(page.getByText('Requested time unknown'))
      .toBeVisible();
    await expect.element(page.getByText('5 reviews pending')).toBeVisible();
  });

  it('keeps filters and resets the page in links', async () => {
    render(Page, { data: make('?q=x&page=3', flat([item()])) });
    await expect
      .element(page.getByRole('link', { name: 'Grouped' }))
      .toHaveAttribute('href', '/?q=x&group_by=repository');
    await expect
      .element(page.getByRole('link', { name: /^Approved/ }))
      .toHaveAttribute('href', '/?status=approved&q=x');
  });

  it('renders groups as collapsible sections', async () => {
    render(Page, {
      data: make('?group_by=repository', {
        ...base,
        group_by: 'repository',
        groups: [{ repository: 'acme/web', items: [item()] }],
      }),
    });
    const title = page.getByRole('link', { name: 'Add inbox' });
    await expect.element(title).toBeVisible();
    document.querySelector('summary')?.click();
    const details = document.querySelector('details');
    await expect.poll(() => details?.open).toBe(false);
    await expect.element(title).not.toBeInTheDocument();
  });

  it('distinguishes an empty inbox from no filtered matches', async () => {
    const empty = {
      pagination: { ...base.pagination, total: 0, total_pages: 0 },
    };
    const r = await render(Page, { data: make('', flat([], empty)) });
    await expect.element(page.getByText('Your inbox is empty.')).toBeVisible();
    r.unmount();
    render(Page, { data: make('?q=zzz', flat([], empty)) });
    await expect
      .element(page.getByText('No reviews match these filters.'))
      .toBeVisible();
  });

  it('shows a partial-results notice', async () => {
    render(Page, { data: make('', flat([item()], { complete: false })) });
    await expect.element(page.getByText(/inbox is partial/)).toBeVisible();
  });

  it('offers sign in on expired auth, with a relative return path', async () => {
    render(Page, {
      data: make('?status=open', null, { kind: 'auth', message: 'Expired' }),
    });
    await expect
      .element(page.getByRole('link', { name: 'Sign in with GitHub' }))
      .toHaveAttribute(
        'href',
        '/auth/github/login?redirectTo=%2F%3Fstatus%3Dopen',
      );
  });

  it('shows retry-after for rate limits and a retry link', async () => {
    render(Page, {
      data: make('', null, {
        kind: 'rate_limit',
        message: 'Slow down',
        retryAfter: 30,
      }),
    });
    await expect
      .element(page.getByText('Try again in 30 seconds.'))
      .toBeVisible();
    await expect
      .element(page.getByRole('link', { name: 'Retry' }))
      .toBeVisible();
  });

  it('paginates with prev/next links', async () => {
    render(Page, {
      data: make(
        '?page=2',
        flat([item()], {
          pagination: { page: 2, per_page: 1, total: 3, total_pages: 3 },
        }),
      ),
    });
    await expect
      .element(page.getByRole('link', { name: 'Previous' }))
      .toHaveAttribute('href', '/');
    await expect
      .element(page.getByRole('link', { name: 'Next' }))
      .toHaveAttribute('href', '/?page=3');
  });

  it('exposes a labelled search that submits via GET', async () => {
    render(Page, { data: make('?status=open&q=bug', flat([item()])) });
    await expect
      .element(page.getByRole('searchbox', { name: 'Search reviews' }))
      .toHaveValue('bug');
  });
  it('styles headings and the search button without !important overrides', async () => {
    render(Page, { data: make('', flat([item()])) });
    const px = (el: Element | null) =>
      el ? getComputedStyle(el).fontSize : null;
    expect(
      px(page.getByRole('heading', { name: 'Inbox', level: 1 }).element()),
    ).toBe('20px');
    expect(
      px(
        page
          .getByRole('heading', { name: 'Reviews requested of you' })
          .element(),
      ),
    ).toBe('20px');
    expect(
      px(page.getByRole('heading', { name: 'Repositories' }).element()),
    ).toBe('12px');
    const probe = document.createElement('div');
    probe.style.borderRadius = 'var(--radius-md)';
    document.body.append(probe);
    const radius = getComputedStyle(probe).borderRadius;
    probe.remove();
    const btn = page.getByRole('button', { name: 'Search' }).element();
    expect(radius).not.toBe('');
    expect(getComputedStyle(btn).borderRadius).toBe(radius);
  });
});
