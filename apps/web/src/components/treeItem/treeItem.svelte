<script lang="ts" module>
import {
	ChevronRightIcon,
	FileIcon,
	FolderIcon,
	FolderOpenIcon,
} from 'lucide-svelte';
import type { Snippet } from 'svelte';
import type { ClassValue } from 'svelte/elements';

export type TreeItemProps = {
	/** Row kind — drives the icon and whether a chevron is rendered. */
	type?: 'folder' | 'file';
	/** Text label for the row. */
	name: string;
	/** Selected (active) row styling. */
	selected?: boolean;
	/** Folder open/closed state — rotates the chevron and swaps the folder glyph. */
	expanded?: boolean;
	/** Nesting depth; adds 12px of left padding per level on top of the base 12px. */
	depth?: number;
	class?: ClassValue;
	/** Optional trailing content, e.g. a `<DiffStats />` or `<Badge />`. */
	children?: Snippet<[]>;
	onclick?: (event: MouseEvent) => void;
};
</script>

<script lang="ts">
  let {
    type = 'file',
    name,
    selected = false,
    expanded = false,
    depth = 0,
    class: className,
    children,
    onclick,
  }: TreeItemProps = $props();
</script>

<!--
  Figma "Tree Item" (node 26:218). The Type=Folder/File and State=Default/Selected
  variants map to props; Theme=Light/Dark is collapsed onto light-dark().
-->
<button
  type="button"
  class={["tree-item custom", className]}
  data-selected={selected}
  aria-current={selected ? 'true' : undefined}
  style="padding-left: {12 + depth * 12}px"
  {onclick}
>
  {#if type === 'folder'}
    <span class={["tree-item__chevron", { expanded }]}>
      <ChevronRightIcon size={14} aria-hidden="true" />
    </span>
    <span class="tree-item__icon tree-item__icon--folder">
      {#if expanded}
        <FolderOpenIcon size={16} aria-hidden="true" />
      {:else}
        <FolderIcon size={16} aria-hidden="true" />
      {/if}
    </span>
  {:else}
    <span class="tree-item__spacer"></span>
    <span class="tree-item__icon tree-item__icon--file">
      <FileIcon size={16} aria-hidden="true" />
    </span>
  {/if}

  <span class="tree-item__label">{name}</span>

  {#if children}
    <span class="tree-item__trailing">{@render children()}</span>
  {/if}
</button>

<style>
  .tree-item {
    display: flex;
    width: 100%;
    align-items: center;
    gap: --spacing(2);
    padding-block: --spacing(1.5);
    padding-right: --spacing(3);
    border: 0;
    border-radius: var(--radius-sm);
    background-color: transparent;
    text-align: left;
    font-family: inherit;
    font-size: 13px;
    font-weight: var(--font-weight-normal);
    line-height: 1;
    color: light-dark(var(--color-slate-600), #8b949e);
    cursor: pointer;
  }

  .tree-item:hover:not([data-selected="true"]) {
    background-color: light-dark(var(--color-slate-100), #1c2128);
  }

  .tree-item:focus-visible {
    outline: 2px solid light-dark(var(--color-blue-500), var(--color-blue-400));
    outline-offset: -2px;
  }

  .tree-item[data-selected="true"] {
    background-color: light-dark(#eff6ff, #1f2937);
    font-weight: var(--font-weight-medium);
    color: light-dark(var(--color-slate-900), #c9d1d9);
  }

  .tree-item__chevron,
  .tree-item__icon {
    display: inline-flex;
    flex-shrink: 0;
  }

  .tree-item__spacer {
    display: inline-block;
    flex-shrink: 0;
    width: 14px;
  }

  .tree-item__chevron {
    color: light-dark(var(--color-slate-400), #484f58);
    transition: transform 0.15s ease;
  }

  .tree-item__chevron.expanded {
    transform: rotate(90deg);
  }

  .tree-item__icon--folder {
    color: var(--color-yellow-500);
  }

  .tree-item__icon--file {
    color: light-dark(var(--color-slate-400), #484f58);
  }

  .tree-item__label {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: inherit;
  }

  .tree-item__trailing {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
  }
</style>
