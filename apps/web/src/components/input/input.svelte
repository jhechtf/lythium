<script lang="ts" module>
import type { Snippet } from 'svelte';

export type InputProps = {
	children?: Snippet<[]>;
};
</script>

<script lang="ts">
	let { children, ...props } = $props();
</script>

{#snippet input()}
	<input {...props} />
{/snippet}

{#if children}
	<!-- biome-ignore lint/a11y/noLabelWithoutControl: the input is rendered through the input snippet inside this label -->
	<label>
		<span>{@render children()}</span>
		{@render input()}
	</label>
{:else}
	{@render input()}
{/if}

