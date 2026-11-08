<script lang="ts" module>
import type { Snippet } from 'svelte';
import type { ClassValue } from 'svelte/elements';

export type BadgeProps = {
	children?: Snippet<[]>;
	class?: ClassValue;
	variant?: 'default' | 'success' | 'error';
};
</script>

<script lang="ts">
  let { children, class: className = 'px-2 py-0.5', variant = 'default' }: BadgeProps = $props();
</script>

<div class={["badge", className, variant]}>
  {@render children?.()}
</div>

<style>
  .badge {
    /* Figma "Badge" (node 26:6): Theme=Light / Theme=Dark collapsed onto light-dark(). */
    --bg-color: var(--background-color, light-dark(var(--color-slate-100), #161b22));
    --fg-color: var(--text-color, light-dark(var(--color-slate-600), var(--color-white)));
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background-color: var(--bg-color);
    color: var(--fg-color);
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
    font-weight: var(--font-weight-semibold);
    line-height: 1;
    text-align: center;
    white-space: nowrap;

    &.success {
      --bg-color: light-dark(var(--color-emerald-600), var(--color-emerald-400));
      --fg-color: light-dark(var(--color-zinc-100), var(--color-zinc-900));
    }

    &.error {
      --bg-color: light-dark(var(--color-red-600), var(--color-red-500));
      --fg-color: light-dark(var(--color-red-50), var(--color-red-950));
    }
  }
</style>
