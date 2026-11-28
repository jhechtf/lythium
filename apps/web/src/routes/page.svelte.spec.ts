import type { InboxItem } from '@lythium/api/types';
import type { ComponentProps } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    await expect.element(page.getByText('3h ago')).toBeVisible();
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
  describe('design tokens (Figma Review Inbox, dark)', () => {
    const ctx = document.createElement('canvas').getContext('2d', {
      willReadFrequently: true,
    }) as CanvasRenderingContext2D;
    /** Computed value, with any colour normalised to `rgb(r, g, b)`. */
    const css = (el: Element, prop: string) => {
      const v = getComputedStyle(el).getPropertyValue(prop);
      if (!/^(oklch|oklab|color|rgb|lab|lch)\(/.test(v)) return v;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return a === 0 ? 'transparent' : `rgb(${r}, ${g}, ${b})`;
    };
    const row = (over: Partial<InboxItem> = {}) =>
      item({ statuses: ['changes_requested'], ...over });

    beforeEach(() => {
      document.body.style.colorScheme = 'dark';
    });
    afterEach(() => {
      document.body.style.colorScheme = '';
    });

    it('uses the mock palette for page, panels, rows and borders', async () => {
      render(Page, { data: make('', flat([row(), item({ number: 8 })])) });
      const root = document.querySelector('.inbox') as Element;
      expect(css(root, 'background-color')).toBe('rgb(8, 11, 17)');
      expect(
        css(document.querySelector('aside') as Element, 'background-color'),
      ).toBe('rgb(12, 15, 25)');
      const rows = document.querySelectorAll('.table li');
      expect(css(rows[0], 'background-color')).toBe('rgb(17, 22, 37)');
      expect(css(rows[0], 'border-bottom-color')).toBe('rgb(31, 41, 61)');
      expect(css(rows[0], 'border-left-color')).toBe('rgb(48, 34, 32)');
      expect(css(rows[1], 'border-left-color')).toBe('rgba(0, 0, 0, 0)');
      const h1 = page.getByRole('heading', { level: 1 }).element();
      expect(h1.textContent).toBe('Review Inbox');
      expect(css(h1, 'font-size')).toBe('24px');
    });

    it('selected repo and layout use the indigo selection, not zinc', async () => {
      render(Page, { data: make('?repo=acme/web', flat([row()])) });
      const sel = document.querySelector(
        '.repos a[aria-current="page"]',
      ) as Element;
      expect(sel.textContent).toContain('acme/web');
      expect(css(sel, 'background-color')).toBe('rgb(30, 27, 75)');
      expect(css(sel, 'color')).toBe('rgb(243, 244, 246)');
      const flatTab = page.getByRole('link', { name: 'Flat' }).element();
      expect(css(flatTab, 'background-color')).toBe('rgb(22, 29, 48)');
    });

    it('colours status chips and the changes-requested accent', async () => {
      render(Page, {
        data: make(
          '',
          flat([
            row(),
            item({ number: 8, statuses: ['approved'] }),
            item({ number: 9 }),
          ]),
        ),
      });
      const chip = (n: string) =>
        document.querySelector(`.status-badge.${n}`) as Element;
      expect(css(chip('changes_requested'), 'color')).toBe('rgb(251, 191, 36)');
      expect(css(chip('approved'), 'color')).toBe('rgb(52, 211, 153)');
      expect(css(chip('open'), 'color')).toBe('rgb(96, 165, 250)');
      expect(css(chip('open'), 'background-color')).toBe('rgb(19, 30, 63)');
      expect(css(chip('open'), 'border-top-color')).toBe('rgb(22, 45, 111)');
      const ages = [...document.querySelectorAll('.age')];
      expect(css(ages[0], 'color')).toBe('rgb(251, 191, 36)');
      expect(css(ages[1], 'color')).toBe('rgb(107, 114, 128)');
    });

    it('styles the grouped header and the focused row', async () => {
      render(Page, {
        data: make('?group_by=repository', {
          ...base,
          group_by: 'repository',
          groups: [
            { repository: 'acme/web', items: [row(), item({ number: 8 })] },
          ],
        }),
      });
      const summary = document.querySelector('summary') as Element;
      expect(css(summary, 'background-color')).toBe('rgb(22, 29, 48)');
      expect(summary.textContent).toContain('2 reviews');
      const link = page
        .getByRole('link', { name: 'Add inbox' })
        .first()
        .element() as HTMLElement;
      link.focus();
      const li = link.closest('li') as Element;
      const shadow = getComputedStyle(li).boxShadow;
      expect(css(li, 'background-color')).toBe('rgb(21, 23, 47)');
      expect(shadow).toContain('rgb(99, 102, 241)');
    });

    it('lays rows out as the mock table on wide viewports', async () => {
      render(Page, { data: make('', flat([row()])) });
      const head = document.querySelector('.table-head') as Element;
      expect(css(head, 'background-color')).toBe('rgb(12, 15, 25)');
      if (matchMedia('(min-width: 75rem)').matches) {
        expect(css(head, 'display')).toBe('grid');
        expect(
          css(document.querySelector('.table li') as Element, 'display'),
        ).toBe('grid');
      }
    });

    it('keeps the search button radius, without !important', async () => {
      render(Page, { data: make('', flat([item()])) });
      const probe = document.createElement('div');
      probe.style.borderRadius = 'var(--radius-md)';
      document.body.append(probe);
      const radius = getComputedStyle(probe).borderRadius;
      probe.remove();
      const btn = page.getByRole('button', { name: 'Search' }).element();
      expect(radius).not.toBe('');
      expect(getComputedStyle(btn).borderRadius).toBe(radius);
      expect(
        css(
          page.getByRole('heading', { name: 'Repositories' }).element(),
          'font-size',
        ),
      ).toBe('11px');
    });
  });
});
