<script lang="ts" module>
import type { ClassValue } from 'svelte/elements';

export type SidebarItemStatus = 'reviewed' | 'current' | 'pending';
export type SidebarItemTheme = 'auto' | 'light' | 'dark';

export type SidebarItemProps = {
	/** Review state of the group: drives the indicator, colors and `aria-current`. */
	status?: SidebarItemStatus;
	/** Group label. */
	label: string;
	/** Number shown in the count badge (0 is rendered). */
	count: number;
	/**
	 * `auto` follows the inherited `color-scheme`; `light` / `dark` force it.
	 */
	theme?: SidebarItemTheme;
	class?: ClassValue;
	onclick?: (event: MouseEvent) => void;
};

const statusText: Record<SidebarItemStatus, string> = {
	reviewed: 'Reviewed',
	current: 'Current',
	pending: 'Pending',
};
</script>

<script lang="ts">
  import Badge from '#components/badge/badge.svelte';
  import currentDark from './current-dark.svg';
  import currentLight from './current-light.svg';

  let {
    status = 'pending',
    label,
    count,
    theme = 'auto',
    class: className,
    onclick,
  }: SidebarItemProps = $props();
</script>

<!--
  Figma "Sidebar Item" (node 26:61): Status=Reviewed/Current/Pending x
  Theme=Light/Dark. `auto` collapses the themes onto `light-dark()`.
-->
<button
  type="button"
  class={["sidebar-item custom", className]}
  data-status={status}
  data-theme={theme === 'auto' ? undefined : theme}
  aria-current={status === 'current' ? 'true' : undefined}
  {onclick}
>
  <span class="sidebar-item__status" aria-hidden="true">
    {#if status === 'current'}
      <img class="sidebar-item__icon sidebar-item__icon--light" src={currentLight} alt="" width="20" height="20" />
      <img class="sidebar-item__icon sidebar-item__icon--dark" src={currentDark} alt="" width="20" height="20" />
    {:else if status === 'reviewed'}
      <span class="sidebar-item__check">✓</span>
    {:else}
      <span class="sidebar-item__ring"></span>
    {/if}
  </span>
  <span class="sidebar-item__label">{label}</span>
  <span class="sidebar-item__sr">{statusText[status]}</span>
  <span class="sidebar-item__badge">
    <Badge>{count}</Badge>
  </span>
</button>

<style>
  .sidebar-item {
    --si-label: light-dark(#475569, #8b949e);
    --si-ring-bg: light-dark(#fff, #161b22);
    --si-ring-border: light-dark(#cbd5e1, #484f58);
    --si-current-bg: light-dark(#eff6ff, #1f2937);
    --si-current-border: light-dark(#e2e8f0, #21262d);
    --si-current-text: light-dark(#2563eb, #58a6ff);
    --si-focus: light-dark(var(--color-blue-500), var(--color-blue-400));

    display: flex;
    box-sizing: border-box;
    width: 100%;
    align-items: center;
    gap: 12px;
    /* 1px transparent border on every status so Current does not shift layout. */
    padding: 12px 15px;
    border: 1px solid transparent;
    border-radius: 8px;
    background-color: transparent;
    color: var(--si-label);
    font-family: Geist, ui-sans-serif, system-ui, sans-serif;
    font-size: 14px;
    font-weight: 500;
    line-height: normal;
    text-align: left;
    cursor: pointer;
  }

  .sidebar-item[data-theme="light"] {
    color-scheme: light;
  }

  .sidebar-item[data-theme="dark"] {
    color-scheme: dark;
  }

  .sidebar-item:focus-visible {
    outline: 2px solid var(--si-focus);
    outline-offset: 2px;
  }

  .sidebar-item[data-status="current"] {
    background-color: var(--si-current-bg);
    border-color: var(--si-current-border);
    color: var(--si-current-text);
  }

  .sidebar-item__status {
    display: inline-flex;
    flex-shrink: 0;
    width: 20px;
    height: 20px;
  }

  .sidebar-item__icon {
    display: block;
    width: 20px;
    height: 20px;
  }

  /* Current ships separate light/dark SVGs; pick by theme (auto: color scheme). */
  .sidebar-item__icon--dark {
    display: none;
  }

  @media (prefers-color-scheme: dark) {
    .sidebar-item:not([data-theme]) .sidebar-item__icon--light {
      display: none;
    }
    .sidebar-item:not([data-theme]) .sidebar-item__icon--dark {
      display: block;
    }
  }

  .sidebar-item[data-theme="dark"] .sidebar-item__icon--light {
    display: none;
  }

  .sidebar-item[data-theme="dark"] .sidebar-item__icon--dark {
    display: block;
  }

  .sidebar-item__check {
    display: inline-flex;
    width: 20px;
    height: 20px;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    background-color: #22c55e;
    color: #fff;
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
  }

  .sidebar-item__ring {
    box-sizing: border-box;
    width: 20px;
    height: 20px;
    border: 2px solid var(--si-ring-border);
    border-radius: 10px;
    background-color: var(--si-ring-bg);
  }

  .sidebar-item__label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sidebar-item__badge {
    display: inline-flex;
    flex-shrink: 0;
    --background-color: light-dark(#f1f5f9, #161b22);
    --text-color: light-dark(#475569, #fff);
  }

  .sidebar-item[data-status="current"] .sidebar-item__badge {
    --background-color: light-dark(#f1f5f9, #2188ff);
  }

  .sidebar-item__sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
