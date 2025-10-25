<script lang="ts" module>
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import Checkbox from './checkbox.svelte';

	const { Story } = defineMeta({
		component: Checkbox,
		tags: ['autodocs']
	});
</script>

<!-- By default you just get a generic checkbox -->
<Story name="Default" />

<!-- You can provide a child element, which gives us a labeled version with click behavior -->
<Story name="With label">
	{#snippet template(args)}
		<Checkbox {...args}>Yes?</Checkbox>
	{/snippet}
</Story>

<Story name="Indeterminate" args={{ indeterminate: true }} />

<Story
	name="Events"
	args={{
		onchange: (e) => {
			alert('CHANGED!', e.target?.value);
		}
	}}
/>
