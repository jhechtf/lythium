<script lang="ts">
  import { ChevronDownIcon, ChevronRightIcon } from 'lucide-svelte';
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

<div class="flex flex-1 min-w-0 flex-col md:flex-row">
  <aside class="w-full md:w-60 md:shrink-0 p-4 border-b md:border-b-0 md:border-r border-zinc-300 dark:border-zinc-800" aria-label="Inbox filters">
    <h1 class="!text-xl">Inbox</h1>
    {#if inbox}
      <p class="text-sm opacity-70">{inbox.counts.pending} {inbox.counts.pending === 1 ? 'review' : 'reviews'} pending</p>
      <h2 class="!text-xs uppercase tracking-wide opacity-60 mt-6 mb-2">Repositories</h2>
      <ul class="repos">
        <li>
          <a href={inboxHref(query, { repo: null })} aria-current={query.repo ? undefined : 'page'}>
            <span>All repositories</span><span>{inbox.counts.pending}</span>
          </a>
        </li>
        {#each inbox.repositories as repo (repo.name)}
          <li>
            <a href={inboxHref(query, { repo: repo.name })} aria-current={query.repo === repo.name ? 'page' : undefined}>
              <span class="truncate">{repo.name}</span><span>{repo.count}</span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </aside>

  <main class="flex-1 min-w-0" aria-busy={navigating.to !== null}>
    <header class="p-4 flex flex-col gap-3 border-b border-zinc-300 dark:border-zinc-800">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="!text-xl">Reviews requested of you</h2>
        <nav class="segmented" aria-label="Layout">
          <a href={inboxHref(query, { group: 'none' })} aria-current={query.group === 'none' ? 'true' : undefined}>Flat</a>
          <a href={inboxHref(query, { group: 'repository' })} aria-current={query.group === 'repository' ? 'true' : undefined}>Grouped</a>
        </nav>
      </div>

      <search>
      <form method="GET" action="/" class="flex gap-2">
        {#if query.status}<input type="hidden" name="status" value={query.status} />{/if}
        {#if query.repo}<input type="hidden" name="repo" value={query.repo} />{/if}
        {#if query.group !== 'none'}<input type="hidden" name="group_by" value={query.group} />{/if}
        <input
          class="search"
          type="search"
          name="q"
          value={query.q}
          maxlength="256"
          placeholder="Search titles, repositories, authors"
          aria-label="Search reviews"
        />
        <button type="submit" class="custom search-btn">Search</button>
      </form>
      </search>

      {#if inbox}
        <nav class="flex flex-wrap gap-2" aria-label="Review status">
          <a class="chip" href={inboxHref(query, { status: null })} aria-current={query.status ? undefined : 'true'}>
            All <span>{inbox.counts.pending}</span>
          </a>
          {#each INBOX_STATUSES as status (status)}
            <a class="chip" href={inboxHref(query, { status })} aria-current={query.status === status ? 'true' : undefined}>
              {STATUS_LABELS[status]} <span>{inbox.counts.status[status]}</span>
            </a>
          {/each}
        </nav>
      {/if}
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
        <div class="notice warn" role="status">
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
      {:else if inbox.group_by === 'none'}
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
              <span class="font-semibold">{group.repository}</span>
              <Badge>{group.items.length}<span class="sr-only"> on this page</span></Badge>
            {/snippet}
            <ul>
              {#each group.items as item (item.number)}
                <InboxRow {item} {now} showRepository={false} />
              {/each}
            </ul>
          </Expandable>
        {/each}
      {/if}

      {#if inbox.pagination.total > 0}
        <nav class="p-4 flex items-center justify-between text-sm" aria-label="Pagination">
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
  .repos { display: flex; flex-direction: column; gap: 2px; }
  .repos a {
    display: flex; justify-content: space-between; gap: 0.5rem;
    padding: 0.375rem 0.5rem; border-radius: var(--radius-md); font-size: var(--text-sm);
    &:hover { background: light-dark(var(--color-zinc-200), var(--color-zinc-800)); }
    &[aria-current='page'] { background: light-dark(var(--color-zinc-200), var(--color-zinc-800)); font-weight: var(--font-weight-semibold); }
  }
  a:focus-visible, .search:focus-visible, .search-btn:focus-visible {
    outline: 2px solid var(--color-blue-500); outline-offset: 2px;
  }
  .segmented { display: inline-flex; border: 1px solid light-dark(var(--color-zinc-300), var(--color-zinc-700)); border-radius: var(--radius-md); overflow: hidden; }
  .segmented a { padding: 0.25rem 0.75rem; font-size: var(--text-sm); }
  .segmented a[aria-current='true'] { background: light-dark(var(--color-zinc-900), var(--color-zinc-100)); color: light-dark(var(--color-white), var(--color-zinc-900)); }
  .search {
    flex: 1; min-width: 0; padding: 0.375rem 0.75rem; border-radius: var(--radius-md); font-size: var(--text-sm);
    border: 1px solid light-dark(var(--color-zinc-300), var(--color-zinc-700));
    background: light-dark(var(--color-white), var(--color-zinc-950));
  }
  .search-btn { border-radius: var(--radius-md) !important; }
  .chip {
    display: inline-flex; gap: 0.375rem; padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: var(--text-sm);
    border: 1px solid light-dark(var(--color-zinc-300), var(--color-zinc-700));
    &[aria-current='true'] { background: light-dark(var(--color-zinc-900), var(--color-zinc-100)); color: light-dark(var(--color-white), var(--color-zinc-900)); }
  }
  .notice, .empty { margin: 1rem; padding: 1rem; border-radius: var(--radius-xl); display: flex; flex-direction: column; gap: 0.5rem; align-items: flex-start; }
  .notice { background: var(--color-warning-token); color: var(--color-on-warning-token); }
  .empty { text-align: center; align-items: center; opacity: 0.8; }
  .action { text-decoration: underline; font-weight: var(--font-weight-semibold); }
  :global(.group-summary) {
    display: flex; align-items: center; gap: 0.5rem; padding: 0.75rem 1rem;
    background: light-dark(var(--color-zinc-200), var(--color-zinc-800));
  }
</style>
