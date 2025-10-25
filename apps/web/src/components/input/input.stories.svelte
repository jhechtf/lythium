<script lang="ts" module>
import { defineMeta } from '@storybook/addon-svelte-csf';
import Input from './input.svelte';

const { Story } = defineMeta({ component: Input });
</script>

<Story name="Default" />

<Story name="With label">
  {#snippet template(args)}
    <Input placeholder="Placeholder" type="search" autofocus {...args}>
      Search
    </Input>
  {/snippet}
</Story>