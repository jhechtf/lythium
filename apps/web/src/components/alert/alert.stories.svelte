<script lang="ts" module>
import { defineMeta } from '@storybook/addon-svelte-csf';
import Alert from './alert.svelte';
import { TriangleAlertIcon } from 'lucide-svelte';

const { Story } = defineMeta({
	component: Alert,
	tags: ['autodocs'],
	args: {
		children: defaultChildren,
	},
});
</script>
{#snippet defaultChildren()}
  I am the alert
{/snippet}

<Story name="Default" />
<Story name="With Icon">
  {#snippet template(args)}
    <Alert {...args}>
      <div class="flex gap-4">
        <TriangleAlertIcon size="1.5em" />
        fjkasdldfjaskfjlkjlkd
      </div>
    </Alert>
  {/snippet}
</Story>