<script lang="ts" module>
	import type { Snippet } from "svelte";
	import type { ClassValue } from "svelte/elements";

  export type BadgeProps = {
    children?: Snippet<[]>;
    class?: ClassValue;
    variant?: 'default' | 'success' | 'error';
  };

</script>

<script lang="ts">
  let { children, class: className = 'px-2 py-1', variant = 'default' }: BadgeProps = $props();

</script>

<div class={["badge", className, variant]}>
  {@render children?.()}
</div>

<style>
  .badge {
    --bg-color: var(--background-color, var(--color-zinc-500));
    --fg-color: var(--text-color, inherit);
    display: inline-block;
    background-color: var(--bg-color);
    color: var(--text-color);
    border-radius: 999px;

    &.success {
      --bg-color: light-dark(var(--color-emerald-600), var(--color-emerald-400));
      --fg-color: light-dark(var(--color-zinc-900), var(--color-zinc-100));
    }

    &.error {
      --bg-color: light-dark(var(--color-red-600), rgba(from blue r g b));
    }
  }
</style>