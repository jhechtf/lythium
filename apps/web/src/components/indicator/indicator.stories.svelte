<script lang="ts" module>
import { defineMeta } from '@storybook/addon-svelte-csf';
import Indicator from './indicator.svelte';

const { Story } = defineMeta({
	component: Indicator,
	args: {
		type: 'pending',
		inProgress: true,
	},
	tags: ['autodocs'],
});
</script>

<!-- The indicator is primarily used in CI loading state status -->
<Story name="Default" />