<script lang="ts" module>
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import Header from './header.svelte';

  const { Story } = defineMeta({
    component: Header,
  });

</script>

{#snippet defaultChildren()}
  Header Text
{/snippet}

<Story name="Default" args={{ children: defaultChildren }}/>
<Story name="With Actions">
  {#snippet template(args)}
    <Header {...args}>
      Header with children
      {#snippet actions()}
        Actions go here.
      {/snippet}
    </Header>
  {/snippet}
</Story>
