<script lang="ts" module>
	import type { Snippet } from "svelte";
	import type { HTMLDetailsAttributes, ClassValue } from "svelte/elements";

  export type ExpandableProps = {
    children?: Snippet<[]>;
    header?: Snippet<[{ open: boolean }]>;
    open?: boolean;
    summaryClasses?: ClassValue;
  } & Omit<HTMLDetailsAttributes, 'open'>;
</script>
<script lang="ts">
  let { children, header, open = false, summaryClasses = '', ...rest }: ExpandableProps = $props();
</script>

<details {open} {...rest} ontoggle={(e) => {
  open = (e.target as HTMLDetailsElement).open;
}}>
  <summary class={summaryClasses}>{@render header?.({ open })}</summary>
  {@render children?.()}
</details>

<style>
  summary {
    list-style-position: outside;
    cursor: pointer;
    &::marker {
      content: ''
    }
  }
</style>
