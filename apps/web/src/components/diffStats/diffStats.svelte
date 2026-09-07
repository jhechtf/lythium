<script lang="ts" module>
import type { ClassValue } from 'svelte/elements';

export type DiffStatsProps = {
	/** Lines added. */
	additions?: number;
	/** Lines removed. */
	deletions?: number;
	/** Hide a figure when its count is 0. */
	hideZero?: boolean;
	class?: ClassValue;
};
</script>

<script lang="ts">
  let {
    additions = 0,
    deletions = 0,
    hideZero = false,
    class: className,
  }: DiffStatsProps = $props();

  const showAdditions = $derived(!hideZero || additions > 0);
  const showDeletions = $derived(!hideZero || deletions > 0);
</script>

<!-- Figma "Diff Stats" (node 26:13): Theme=Light / Theme=Dark collapsed onto light-dark(). -->
<span class={["diff-stats", className]}>
  {#if showAdditions}
    <span class="additions">+{additions}</span>
  {/if}
  {#if showDeletions}
    <span class="deletions">&minus;{deletions}</span>
  {/if}
</span>

<style>
  .diff-stats {
    display: inline-flex;
    align-items: flex-start;
    gap: --spacing(2);
    font-size: 13px;
    font-weight: var(--font-weight-medium);
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .additions {
    color: light-dark(#137333, #3fb950);
  }

  .deletions {
    color: light-dark(#c5221f, #f85149);
  }
</style>
