<script module lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLInputAttributes } from 'svelte/elements';
  export type CheckboxProps = Omit<HTMLInputAttributes, 'type'> & {
    children?: Snippet<[]>;
    labelSide?: 'start' | 'end';
  };
</script>
<script lang="ts">
  let { children, labelSide = 'end', ...props }: CheckboxProps = $props();
</script>
{#snippet checkbox(args: HTMLInputAttributes)}
  <input {...args} type="checkbox" />
{/snippet}

{#if children}
  <label class="inline-flex gap-2 items-center">
    {#if labelSide === 'start'}
      {@render children()}
    {/if}

    {@render checkbox(props)}

    {#if labelSide === 'end'}
      {@render children()}
    {/if}
  </label>
{:else}
  {@render checkbox(props)}
{/if}