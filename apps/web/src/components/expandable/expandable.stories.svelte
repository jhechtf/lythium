<script lang="ts" module>
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import Expandable from './expandable.svelte';
  const { Story } = defineMeta({
    component: Expandable,
    args: {
      open: true,
    }
  });
</script>

{#snippet defaultChildren()}
  <p>Lorem ipsum dolor sit, amet consectetur adipisicing elit. Nesciunt iure iusto veritatis tempore rem molestiae tenetur, hic necessitatibus commodi, neque, inventore deleniti maiores. Fuga vitae possimus molestias animi minus minima.</p>
  <p>Ipsam odit iste architecto adipisci accusantium soluta omnis magnam nesciunt, rerum minus minima, neque sequi. Ratione, libero! Sapiente dolorum eius facere suscipit, perspiciatis beatae similique, assumenda praesentium rerum distinctio quos.</p>
  <p>Modi illum nulla quas ut. Molestias nostrum hic repellat sit facilis deleniti? Laudantium, illum quo. Nesciunt cum incidunt error quae! Dolorem fuga animi placeat est neque cupiditate? Nostrum, rerum. Corrupti!</p>
{/snippet}

{#snippet defaultHeader()}
  Show more
{/snippet}

<Story name="Default" args={{ children: defaultChildren, header: defaultHeader }}/>

<Story name="Fancier Example" asChild>
  <Expandable class="border rounded p-4">
    {#snippet header({ open })}
      The header is {#if open}Open{:else}Closed{/if}
    {/snippet}
    Beep Boop
  </Expandable>
</Story>