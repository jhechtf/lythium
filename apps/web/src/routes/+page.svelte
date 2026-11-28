<script lang="ts">
  import { ChevronDownIcon, ChevronRightIcon, SearchIcon } from 'lucide-svelte';
  import Badge from '#components/badge/badge.svelte';
  import Expandable from '#components/expandable/expandable.svelte';
  import InboxRow from '#components/inboxRow/inboxRow.svelte';
  import { INBOX_STATUSES, inboxHref, STATUS_LABELS } from '#lib/inbox.ts';
  import { navigating } from '$app/state';

  let { data } = $props();

  const query = $derived(data.query);
  const inbox = $derived(data.inbox);
  const failure = $derived(data.failure);
  const now = Date.now();
  const filtered = $derived(Boolean(query.status || query.repo || query.q));
  const returnTo = $derived(inboxHref(query, { page: query.page }));
  const showing = $derived(
    inbox === null
      ? 0
      : inbox.group_by === 'none'
        ? inbox.items.length
        : inbox.groups.reduce((n, g) => n + g.items.length, 0),
  );
</script>

<svelte:head>
  <title>Review inbox · Lythium</title>
</svelte:head>

<div class="inbox flex flex-1 min-w-0 flex-col md:flex-row">
  <aside aria-label="Inbox filters">
    {#if inbox}
      <h2 class="side-label">Repositories</h2>
      <ul class="repos">
        <li>
          <a href={inboxHref(query, { repo: null })} aria-current={query.repo ? undefined : 'page'}>
            <span>All repositories</span><span class="count">{inbox.counts.pending}</span>
          </a>
        </li>
        {#each inbox.repositories as repo (repo.name)}
          <li>
            <a href={inboxHref(query, { repo: repo.name })} aria-current={query.repo === repo.name ? 'page' : undefined}>
              <span class="truncate">{repo.name}</span><span class="count">{repo.count}</span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </aside>

  <main class="flex-1 min-w-0" aria-busy={navigating.to !== null}>
    <header>
      <div class="title-row">
        <div>
          <h1>Review Inbox</h1>
          <p class="subtitle">Reviews requested of you</p>
        </div>
        <nav class="segmented" aria-label="Layout">
          <a href={inboxHref(query, { group: 'none' })} aria-current={query.group === 'none' ? 'true' : undefined}>Flat</a>
          <a href={inboxHref(query, { group: 'repository' })} aria-current={query.group === 'repository' ? 'true' : undefined}>Grouped</a>
        </nav>
      </div>

      <div class="filter-row">
        <search>
          <form method="GET" action="/">
            {#if query.status}<input type="hidden" name="status" value={query.status} />{/if}
            {#if query.repo}<input type="hidden" name="repo" value={query.repo} />{/if}
            {#if query.group !== 'none'}<input type="hidden" name="group_by" value={query.group} />{/if}
            <span class="search-field">
              <SearchIcon size="14" aria-hidden="true" />
              <input
                class="search"
                type="search"
                name="q"
                value={query.q}
                maxlength="256"
                placeholder="Search titles, repositories, authors"
                aria-label="Search reviews"
              />
            </span>
            <button type="submit" class="custom search-btn">Search</button>
          </form>
        </search>

        {#if inbox}
          <nav class="chips" aria-label="Review status">
            <a class="chip all" href={inboxHref(query, { status: null })} aria-current={query.status ? undefined : 'true'}>
              All <span>{inbox.counts.pending}</span>
            </a>
            {#each INBOX_STATUSES as status (status)}
              <a class="chip {status}" href={inboxHref(query, { status })} aria-current={query.status === status ? 'true' : undefined}>
                {STATUS_LABELS[status]} <span>{inbox.counts.status[status]}</span>
              </a>
            {/each}
          </nav>
          <p class="pending"><strong>{inbox.counts.pending}</strong> {inbox.counts.pending === 1 ? 'review' : 'reviews'} pending</p>
        {/if}
      </div>
    </header>

    {#if failure}
      <div class="notice" role="alert">
        <p>{failure.message}</p>
        {#if failure.kind === 'auth'}
          <a class="action" href="/auth/github/login?redirectTo={encodeURIComponent(returnTo)}">Sign in with GitHub</a>
        {:else if failure.kind === 'invalid'}
          <a class="action" href={inboxHref(query, { q: '' })}>Clear search</a>
        {:else}
          {#if failure.kind === 'rate_limit' && failure.retryAfter}
            <p>Try again in {failure.retryAfter} {failure.retryAfter === 1 ? 'second' : 'seconds'}.</p>
          {/if}
          <a class="action" href={returnTo} data-sveltekit-reload>Retry</a>
        {/if}
      </div>
    {:else if inbox}
      {#if !inbox.complete}
        <div class="notice" role="status">
          This inbox is partial: some reviews were not loaded, so counts may be lower than they really are.
        </div>
      {/if}

      {#if inbox.pagination.total === 0}
        <div class="empty">
          {#if filtered}
            <p><strong>No reviews match these filters.</strong></p>
            <a class="action" href="/">Clear filters</a>
          {:else}
            <p><strong>Your inbox is empty.</strong></p>
            <p>Nobody is waiting on your review.</p>
          {/if}
        </div>
      {:else if showing === 0}
        <div class="empty">
          <p><strong>Page {inbox.pagination.page} is past the last page.</strong></p>
          <a class="action" href={inboxHref(query, { page: 1 })}>Go to page 1</a>
        </div>
      {:else}
        <div class="table">
          <div class="table-head" aria-hidden="true">
            <span>{inbox.group_by === 'none' ? 'Pull request / repository' : 'Pull request / repository group'}</span>
            <span>Status</span><span>Author</span><span>Chat</span><span class="end">Changes</span><span class="end">Requested</span>
          </div>
          {#if inbox.group_by === 'none'}
            <ul>
              {#each inbox.items as item (`${item.repository}#${item.number}`)}
                <InboxRow {item} {now} />
              {/each}
            </ul>
          {:else}
            {#each inbox.groups as group (group.repository)}
              <Expandable open class="group" summaryClasses="group-summary">
                {#snippet header({ open })}
                  {#if open}<ChevronDownIcon size="16" aria-hidden="true" />{:else}<ChevronRightIcon size="16" aria-hidden="true" />{/if}
                  <span class="group-name">{group.repository}</span>
                  <Badge class="group-count">{group.items.length} {group.items.length === 1 ? 'review' : 'reviews'}<span class="sr-only"> on this page</span></Badge>
                {/snippet}
                <ul>
                  {#each group.items as item (item.number)}
                    <InboxRow {item} {now} showRepository={false} />
                  {/each}
                </ul>
              </Expandable>
            {/each}
          {/if}
        </div>
      {/if}

      {#if inbox.pagination.total > 0}
        <nav class="pagination" aria-label="Pagination">
          <span>
            Page {inbox.pagination.page} of {inbox.pagination.total_pages} · {inbox.pagination.total} {inbox.pagination.total === 1 ? 'review' : 'reviews'}{filtered ? ' matching' : ''}
          </span>
          <span class="flex gap-3">
            {#if inbox.pagination.page > 1}
              <a class="action" rel="prev" href={inboxHref(query, { page: inbox.pagination.page - 1 })}>Previous</a>
            {/if}
            {#if inbox.pagination.page < inbox.pagination.total_pages}
              <a class="action" rel="next" href={inboxHref(query, { page: inbox.pagination.page + 1 })}>Next</a>
            {/if}
          </span>
        </nav>
      {/if}
    {/if}
  </main>
</div>

<style>
  /*
   * Tailwind 4's palette is oklch and differs slightly from the mock's hex
   * values, so the mock colours are literal hex here.
   * Figma "Review Inbox" (nodes 34:1636 flat, 35:1636 grouped). The mocks are
   * dark only, so the dark half of each light-dark() pair is the mock value;
   * the light half reuses the app's existing zinc/tint tokens (no light mock).
   */
  .inbox {
    --i-page: light-dark(var(--color-zinc-100), #080b11);
    --i-panel: light-dark(var(--color-white), #0c0f19);
    --i-surface: light-dark(var(--color-white), #111625);
    --i-raised: light-dark(var(--color-zinc-200), #161d30);
    --i-border: light-dark(var(--color-zinc-300), #1f293d);
    --i-select: light-dark(var(--color-indigo-100), #1e1b4b);
    --i-select-fg: light-dark(var(--color-indigo-950), #f3f4f6);
    --i-accent: #6366f1;
    --i-focus: light-dark(var(--color-indigo-50), #15172f);
    --i-fg: light-dark(var(--color-zinc-900), #f3f4f6);
    --i-fg-2: light-dark(var(--color-zinc-600), #9ca3af);
    --i-fg-3: light-dark(var(--color-zinc-500), #6b7280);
    --i-open-fg: light-dark(var(--color-blue-700), #60a5fa);
    --i-open-bg: light-dark(var(--color-blue-50), #131e3f);
    --i-open-border: light-dark(var(--color-blue-200), #162d6f);
    --i-approved-fg: light-dark(var(--color-emerald-700), #34d399);
    --i-approved-bg: light-dark(var(--color-emerald-50), #10212a);
    --i-approved-border: light-dark(var(--color-emerald-200), #0d3533);
    --i-changes-fg: light-dark(var(--color-amber-700), #fbbf24);
    --i-changes-bg: light-dark(var(--color-amber-50), #231c2a);
    --i-changes-border: light-dark(var(--color-amber-200), #3e2422);
    --inbox-cols: minmax(0, 1fr) 10.375rem 9.75rem 4.375rem 6.5rem 6rem;
    background: var(--i-page);
    color: var(--i-fg);
  }
  aside {
    width: 100%; padding: 1rem; background: var(--i-panel);
    border-bottom: 1px solid var(--i-border);
    @media (min-width: 48rem) { width: 15rem; flex-shrink: 0; border-bottom: 0; border-right: 1px solid var(--i-border); }
  }
  .side-label {
    font-size: 11px; font-weight: var(--font-weight-semibold); letter-spacing: 0.04em;
    text-transform: uppercase; color: var(--i-fg-3); margin: 0.5rem 0 0.5rem 0.5rem;
  }
  .repos { display: flex; flex-direction: column; gap: 2px; }
  .repos a {
    display: flex; justify-content: space-between; gap: 0.5rem;
    padding: 0.5rem; border-radius: var(--radius-md); font-size: var(--text-sm); color: var(--i-fg-2);
    &:hover { color: var(--i-fg); }
    &[aria-current='page'] { background: var(--i-select); color: var(--i-select-fg); font-weight: var(--font-weight-semibold); }
  }
  .count { font-size: 12px; color: var(--i-fg-3); }
  [aria-current='page'] .count { color: var(--i-accent); }

  main { padding: 1rem; @media (min-width: 48rem) { padding: 2rem; } }
  header { display: flex; flex-direction: column; gap: 1.5rem; margin-bottom: 1.5rem; }
  .title-row { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: flex-start; justify-content: space-between; }
  h1 { font-size: var(--text-2xl); font-weight: var(--font-weight-bold); line-height: 1.2; }
  .subtitle { font-size: 13px; color: var(--i-fg-2); margin-top: 0.25rem; }
  .filter-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; }
  .pending { margin-left: auto; font-size: 13px; color: var(--i-fg-2); strong { color: var(--i-fg); } }

  a:focus-visible, .search:focus-visible, .search-btn:focus-visible {
    outline: 2px solid var(--i-accent); outline-offset: 2px;
  }
  .segmented { display: inline-flex; gap: 2px; padding: 2px; background: var(--i-surface); border: 1px solid var(--i-border); border-radius: var(--radius-md); }
  .segmented a { padding: 0.25rem 0.75rem; font-size: 13px; color: var(--i-fg-2); border: 1px solid transparent; border-radius: var(--radius-sm); }
  .segmented a[aria-current='true'] { background: var(--i-raised); border-color: #3b4f73; color: var(--i-fg); font-weight: var(--font-weight-semibold); }

  search { max-width: 100%; }
  search form { display: flex; gap: 0.5rem; }
  .search-field {
    display: flex; align-items: center; gap: 0.5rem; padding-inline: 0.75rem; flex: 0 1 21rem; min-width: 0;
    background: var(--i-surface); border: 1px solid var(--i-border); border-radius: var(--radius-md); color: var(--i-fg-3);
    &:focus-within { border-color: var(--i-accent); }
  }
  .search { flex: 1; min-width: 0; padding-block: 0.375rem; font-size: 13px; color: var(--i-fg); background: transparent; }
  .search:focus-visible { outline: none; }
  .search::placeholder { color: var(--i-fg-3); }
  .search-btn {
    padding: 0.375rem 0.75rem; font-size: 13px; color: var(--i-fg-2); cursor: pointer;
    background: var(--i-surface); border: 1px solid var(--i-border); border-radius: var(--radius-md);
    &:hover { color: var(--i-fg); border-color: var(--i-accent); }
  }

  .chips { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .chip {
    display: inline-flex; gap: 0.375rem; padding: 0.3125rem 0.625rem; border-radius: var(--radius-md); font-size: 13px; font-weight: var(--font-weight-semibold);
    color: var(--i-fg-2); background: var(--i-surface); border: 1px solid var(--i-border);
    span { font-size: 11px; font-weight: var(--font-weight-medium); }
    &.open { color: var(--i-open-fg); background: var(--i-open-bg); border-color: var(--i-open-border); }
    &.approved { color: var(--i-approved-fg); background: var(--i-approved-bg); border-color: var(--i-approved-border); }
    &.changes_requested { color: var(--i-changes-fg); background: var(--i-changes-bg); border-color: var(--i-changes-border); }
    &[aria-current='true'] { box-shadow: 0 0 0 1px var(--i-accent); }
    &.all[aria-current='true'] { background: var(--i-select); color: var(--i-select-fg); border-color: var(--i-accent); }
  }

  .table { border: 1px solid var(--i-border); border-radius: var(--radius-lg); background: var(--i-surface); overflow: hidden; }
  .table-head {
    display: none; padding: 0.625rem 1rem; background: var(--i-panel); border-bottom: 1px solid var(--i-border);
    font-size: 11px; font-weight: var(--font-weight-semibold); letter-spacing: 0.04em; text-transform: uppercase; color: var(--i-fg-3);
    @media (min-width: 75rem) {
      display: grid; grid-template-columns: var(--inbox-cols);
    }
    .end { text-align: right; }
  }
  :global(.group:not(:first-of-type)) { border-top: 1px solid var(--i-border); }
  :global(.group-summary) {
    display: flex; align-items: center; gap: 0.5rem; padding: 0.75rem 1rem;
    background: var(--i-raised); border-bottom: 1px solid var(--i-border); color: var(--i-fg);
    &:focus-visible { outline: 2px solid var(--i-accent); outline-offset: -2px; }
  }
  .group-name { font-size: var(--text-sm); font-weight: var(--font-weight-semibold); }
  :global(.group-count) {
    --background-color: var(--i-surface); --text-color: var(--i-fg-2);
    padding: 0.125rem 0.5rem; border: 1px solid var(--i-border); font-family: var(--font-mono); font-weight: var(--font-weight-normal);
  }

  .notice, .empty { margin-bottom: 1rem; padding: 1rem; border-radius: var(--radius-lg); display: flex; flex-direction: column; gap: 0.5rem; align-items: flex-start; border: 1px solid var(--i-border); background: var(--i-surface); }
  .notice { color: var(--i-changes-fg); background: var(--i-changes-bg); border-color: var(--i-changes-border); }
  .empty { text-align: center; align-items: center; color: var(--i-fg-2); }
  .action { text-decoration: underline; font-weight: var(--font-weight-semibold); }
  .pagination { padding-block: 1rem; display: flex; align-items: center; justify-content: space-between; font-size: 13px; color: var(--i-fg-2); }
</style>
