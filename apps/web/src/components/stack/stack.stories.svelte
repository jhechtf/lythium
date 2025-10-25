<script lang="ts" module>
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import Stack from './stack.svelte';

	const { Story } = defineMeta({
    title: 'Components/Stack',
		component: Stack,
		args: {
			direction: 'row',
			gap: 'md'
		},
		tags: ['autodocs']
	});
</script>

<!-- The Stack component is fairly straight forward, just making straight forward lists
 of items with pre-configured gaps -->
<Story name="Default">
	{#snippet template(args)}
		<Stack direction={args.direction} gap={args.gap}>
			<div class="rounded-xl bg-surface-token p-3 text-on-surface-token shadow shadow-fuchsia-200">
				<header>Item 1</header>
				<div>This is the first item.</div>
			</div>
			<div class="rounded-xl bg-surface-token p-3 text-on-surface-token shadow shadow-fuchsia-200">
				<header>Item 2</header>
				<div>This is the second item.</div>
			</div>
			<div class="rounded-xl bg-surface-token p-3 text-on-surface-token shadow shadow-fuchsia-200">
				<header>Item 3</header>
				<div>This is the third item.</div>
			</div>
		</Stack>
	{/snippet}
</Story>

<!-- Like most design oriented components, you can add a custom class to the Stack component.
 **NOTE** This may interfere with the classes required for this component work appropriately.
 So please be careful when adding classes  -->
<Story name="Custom Class">
	{#snippet template(args)}
		<Stack direction={args.direction} gap={args.gap} class="bg-amber-300">
			<div class="rounded-xl bg-surface-token p-3 text-on-surface-token shadow shadow-fuchsia-200">
				<header>Item 1</header>
				<div>This is the first item.</div>
			</div>
			<div class="rounded-xl bg-surface-token p-3 text-on-surface-token shadow shadow-fuchsia-200">
				<header>Item 2</header>
				<div>This is the second item.</div>
			</div>
			<div class="rounded-xl bg-surface-token p-3 text-on-surface-token shadow shadow-fuchsia-200">
				<header>Item 3</header>
				<div>This is the third item.</div>
			</div>
		</Stack>
	{/snippet}
</Story>

<!-- Any HTML Div props are forwarded to the component; this includes event listeners -->
<Story name="Custom Properties">
	{#snippet template(args)}
		<Stack direction={args.direction} gap={args.gap} data-testid="custom-stack">
			<div class="rounded-xl bg-surface-token p-3 text-on-surface-token shadow shadow-fuchsia-200">
				<header>Item 1</header>
				<div>This is the first item.</div>
			</div>
			<div class="rounded-xl bg-surface-token p-3 text-on-surface-token shadow shadow-fuchsia-200">
				<header>Item 2</header>
				<div>This is the second item.</div>
			</div>
			<div class="rounded-xl bg-surface-token p-3 text-on-surface-token shadow shadow-fuchsia-200">
				<header>Item 3</header>
				<div>This is the third item.</div>
			</div>
		</Stack>
	{/snippet}
</Story>
