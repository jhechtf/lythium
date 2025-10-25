<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { ClassValue } from 'svelte/elements';
  import type { HTMLAttributes } from 'svelte/elements';

	export type StackProps = {
		children: Snippet<[]>;
		direction?: 'row' | 'column';
		gap?: 'sm' | 'md' | 'lg';
    class?: ClassValue;
  } & Omit<HTMLAttributes<HTMLDivElement>, 'class' >;
</script>

<script lang="ts">
	let { children, direction = 'row', gap = 'md', class: className, ...rest }: StackProps = $props();
</script>

<div
	class={[
		'flex',
		direction === 'column' ? 'flex-col' : 'flex-row',
    gap,
    className,
	]}
  {...rest}
>
	{@render children?.()}
</div>

<style>
  .sm {
    gap: 0.5rem;
  }

  .md {
    gap: 1rem;
  }

  .lg {
    gap: 1.75rem;
  }

</style>