<script lang="ts" module>
import { defineMeta } from '@storybook/addon-svelte-csf';
import { TriangleAlertIcon } from 'lucide-svelte';
import type { ComponentProps } from 'svelte';
import Alert from './alert.svelte';

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
  {#snippet template(args: ComponentProps<typeof Alert>)}
    {@const { children: _children, ...rest } = args}
    <Alert {...rest}>
      <div class="flex gap-4">
        <TriangleAlertIcon size="1.5em" />
        fjkasdldfjaskfjlkjlkd
      </div>
    </Alert>
  {/snippet}
</Story>