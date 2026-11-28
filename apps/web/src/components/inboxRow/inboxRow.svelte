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
  import { MessageCircleIcon } from 'lucide-svelte';
  import Badge from '#components/badge/badge.svelte';
  import DiffStats from '#components/diffStats/diffStats.svelte';
  import { prHref, relativeTime, STATUS_LABELS } from '#lib/inbox.ts';

  let { item, showRepository = true, now = Date.now() }: InboxRowProps = $props();

  const age = $derived(relativeTime(item.requested_at, now));
  const variants = { open: 'default', approved: 'success', changes_requested: 'error' } as const;
</script>

<li class="row" class:hot={item.statuses.includes('changes_requested')} class:nested={!showRepository}>
  <div class="main">
    <span class="ref">{showRepository ? `${item.repository}` : ''}#{item.number}</span>
    <a class="title" title={item.title} href={prHref(item.repository, item.number)}>{item.title}</a>
  </div>
  <span class="badges">
    {#each item.statuses as status (status)}
      <Badge class="status-badge {status}">{STATUS_LABELS[status]}</Badge>
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
  <span class="comments" class:none={item.comments === 0} title="{item.comments} comments">
    <MessageCircleIcon size="14" aria-hidden="true" />
    {item.comments}<span class="sr-only"> comments</span>
  </span>
  <span class="changes"><DiffStats additions={item.additions} deletions={item.deletions} /></span>
  <span class="age">
    {#if age}
      <time datetime={item.requested_at}>{age}</time>
    {:else}
      Requested time unknown
    {/if}
  </span>
</li>

<style>
  @reference "#app.css";

  /* Figma "Review Inbox" row; tokens (--i-*) come from the inbox page. */
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: --spacing(2) --spacing(5);
    padding: --spacing(3) --spacing(4);
    background: var(--i-surface);
    border-bottom: 1px solid var(--i-border);
    border-left: 2px solid transparent;
    font-size: 13px;
    color: var(--i-fg-2);
    &:last-child { border-bottom: 0; }
    &.hot { border-left-color: light-dark(var(--color-amber-400), #302220); }
    &:focus-within {
      background: var(--i-focus);
      box-shadow: inset 0 0 0 1px var(--i-accent);
    }
    @media (min-width: 75rem) {
      display: grid;
      grid-template-columns: var(--inbox-cols);
      gap: 0;
      .main { padding-right: --spacing(4); }
      &.nested .main { padding-left: --spacing(4); }
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
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--i-fg-2);
    .hot & { color: var(--i-changes-fg); }
  }
  .title {
    font-size: var(--text-sm);
    font-weight: var(--font-weight-semibold);
    color: var(--i-fg);
    overflow-wrap: anywhere;
    @media (min-width: 75rem) {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    &:hover { text-decoration: underline; }
  }
  .badges { display: inline-flex; gap: --spacing(1); flex-wrap: wrap; }
  .row :global(.status-badge) {
    --background-color: var(--i-open-bg);
    --text-color: var(--i-open-fg);
    gap: --spacing(1.5);
    padding: --spacing(1) --spacing(2);
    border: 1px solid var(--i-open-border);
    border-radius: var(--radius-sm);
    font-size: 11px;
    &::before { content: ''; width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }
  }
  .row :global(.status-badge.approved) { --background-color: var(--i-approved-bg); --text-color: var(--i-approved-fg); border-color: var(--i-approved-border); }
  .row :global(.status-badge.changes_requested) { --background-color: var(--i-changes-bg); --text-color: var(--i-changes-fg); border-color: var(--i-changes-border); }
  .author, .comments { display: inline-flex; align-items: center; gap: --spacing(2); }
  .author { color: var(--i-fg); font-size: var(--text-sm); }
  .author img { border-radius: 9999px; }
  .comments { color: var(--i-fg); &.none { color: var(--i-fg-3); } }
  .changes { display: flex; justify-content: flex-end; }
  .changes :global(.additions) { color: light-dark(var(--color-emerald-700), #34d399); }
  .changes :global(.deletions) { color: light-dark(var(--color-red-700), #f87171); }
  .age {
    text-align: right;
    font-size: 12px;
    color: var(--i-fg-3);
    .hot & { color: var(--i-changes-fg); font-weight: var(--font-weight-semibold); }
  }
</style>
