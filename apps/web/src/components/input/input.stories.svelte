<script lang="ts" module>
import { defineMeta } from '@storybook/addon-svelte-csf';
import type { ComponentProps } from 'svelte';
import Input from './input.svelte';

const { Story } = defineMeta({ component: Input });
</script>

<Story name="Default" />

<Story name="With label">
  {#snippet template(args: ComponentProps<typeof Input>)}
    {@const { children: _children, ...rest } = args}
    <Input placeholder="Placeholder" type="search" {...rest}>
      Search
    </Input>
  {/snippet}
</Story>