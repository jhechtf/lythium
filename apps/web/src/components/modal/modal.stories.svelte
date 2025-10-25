<script lang="ts" module>
import { defineMeta } from '@storybook/addon-svelte-csf';
import Modal from './modal.svelte';

const { Story } = defineMeta({
	component: Modal,
	args: { children: defaultChildren, open: true },
});
</script>

{#snippet defaultChildren()}
  hey jim
{/snippet}

<Story name="Default" />