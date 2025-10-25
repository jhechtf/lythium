<script lang="ts" module>
	import { defineMeta } from "@storybook/addon-svelte-csf";
  import Badge from './badge.svelte';

  const { Story } = defineMeta({
    component: Badge,
    args: {
      children: template
    },
    tags: ['autodocs']
  })
</script>

{#snippet template()}
  38
{/snippet}

<Story name="Default" />

<!-- 
  There are a handful of variants that the badge can make for itself.
 -->
<Story name="Variants">
  {#snippet template(args)}
    <Badge variant={args.variant}>
      37
    </Badge>
  {/snippet}
</Story>

<!-- 
  You can pass in custom colors using the `--background-color` and `--text-color`
  properties respectively
 -->
<Story name="Custom Colors">
  {#snippet template(args)}
    <Badge --background-color="orange" --text-color="black">
      37
    </Badge>
  {/snippet}
</Story>

<!-- 
  The Badge component accepts a class, which allows you to override the classes 
  applied for padding and text sizing.
 -->
<Story name="Sizing mods">
  {#snippet template(args)}
    <Badge class="px-4 py-3 text-lg font-semibold">
      66
    </Badge>
  {/snippet}
</Story>