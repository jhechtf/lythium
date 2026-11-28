<script lang="ts" module>
import type { InboxItem } from '@lythium/api/types';

export type InboxRowProps = {
  item: InboxItem;
  /** Show the `owner/name` prefix; grouped sections already say it. */
  showRepository?: boolean;
  /** Reference time for the relative age; defaults to now. */
  now?: number;
};
</script>

<script lang="ts">
  import { MessageSquareIcon } from 'lucide-svelte';
  import Badge from '#components/badge/badge.svelte';
  import DiffStats from '#components/diffStats/diffStats.svelte';
  import { prHref, relativeTime, STATUS_LABELS } from '#lib/inbox.ts';

  let { item, showRepository = true, now = Date.now() }: InboxRowProps = $props();

  const age = $derived(relativeTime(item.requested_at, now));
  const variants = { open: 'default', approved: 'success', changes_requested: 'error' } as const;
</script>

<li class="row">
  <div class="main">
    <span class="ref">{showRepository ? `${item.repository} ` : ''}#{item.number}</span>
    <a class="title" href={prHref(item.repository, item.number)}>{item.title}</a>
  </div>
  <div class="meta">
    <span class="badges">
      {#each item.statuses as status (status)}
        <Badge variant={variants[status]}>{STATUS_LABELS[status]}</Badge>
      {/each}
    </span>
    <span class="author">
      {#if item.author}
        <img src="https://github.com/{encodeURIComponent(item.author)}.png?size=40" alt="" width="20" height="20" loading="lazy" />
        {item.author}
      {:else}
        Unknown author
      {/if}
    </span>
    <span class="comments" title="{item.comments} comments">
      <MessageSquareIcon size="14" aria-hidden="true" />
      {item.comments}<span class="sr-only"> comments</span>
    </span>
    <DiffStats additions={item.additions} deletions={item.deletions} />
    <span class="age">
      {#if age}
        <time datetime={item.requested_at}>{age}</time>
      {:else}
        Requested time unknown
      {/if}
    </span>
  </div>
</li>

<style>
  @reference "#app.css";

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: --spacing(2) --spacing(6);
    padding: --spacing(3) --spacing(4);
    border-bottom: 1px solid light-dark(var(--color-zinc-200), var(--color-zinc-800));
    &:has(.title:focus-visible) {
      outline: 2px solid var(--color-blue-500);
      outline-offset: -2px;
    }
  }
  .main {
    display: flex;
    flex-direction: column;
    gap: --spacing(1);
    min-width: 0;
    flex: 1 1 18rem;
  }
  .ref {
    font-size: var(--text-xs);
    color: light-dark(var(--color-zinc-500), var(--color-zinc-400));
  }
  .title {
    font-weight: var(--font-weight-semibold);
    overflow-wrap: anywhere;
    &:hover { text-decoration: underline; }
    &:focus-visible { outline: none; }
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: --spacing(3);
    font-size: 13px;
    color: light-dark(var(--color-zinc-600), var(--color-zinc-400));
  }
  .badges { display: inline-flex; gap: --spacing(1); }
  .author, .comments { display: inline-flex; align-items: center; gap: --spacing(1); }
  .author img { border-radius: 9999px; }
</style>
