<script lang="ts" module>
	import type { Snippet } from "svelte";

  export type HeaderTag = 
    | 'h1'
    | 'h2'
    | 'h3'
    | 'h4'
    | 'h5'
    | 'h6'

  export type HeaderProps = {
    children?: Snippet<[]>;
    tag?: HeaderTag;
    actions?: Snippet<[]>;
    /** Property is ignored if actions slot is unused. */
    actionsAlignment?: ActionAlignment
  };

  export type ActionAlignment = 
    | 'top'
    | 'baseline'
    | 'bottom';

</script>
<script lang="ts">
  let { children, tag = 'h1', actions, actionsAlignment = 'baseline' }: HeaderProps = $props();
</script>

{#snippet header()}
  <svelte:element this={tag}>
    {@render children?.()}
  </svelte:element>
{/snippet}

{#if !actions}
  {@render header()}
{:else}
  <div class={["header", actionsAlignment]}>
    {@render header()}
    <div class="actions">
      {@render actions()}
    </div>
  </div>
{/if}

<style>
  .header {
    display: flex;
    justify-content: space-between;
    &.baseline {
      align-items: baseline;
    }
    &.top {
      align-items: flex-start;
    }
    &.bottom {
      align-items: flex-end;
    }
  }
</style>