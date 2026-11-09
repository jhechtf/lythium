<script lang="ts" module>
import { defineMeta } from '@storybook/addon-svelte-csf';
import Button from './button.svelte';

const { Story } = defineMeta({
  component: Button,
  args: {
    children: template,
  },
  tags: ['autodocs'],
});
</script>

{#snippet template()}
  Finish Review
{/snippet}

<!--
  The default Button matches the Figma "Button" Style=Primary: a blue call to action.
 -->
<Story name="Default" />

<!--
  Figma ships Style=Primary / Secondary / Action.
 -->
<Story name="Variants">
  {#snippet template(args)}
    <div class="flex items-center gap-3">
      <Button>Finish Review</Button>
      <Button variant="secondary">Add comment</Button>
      <Button variant="action">Mark Group as Reviewed</Button>
    </div>
  {/snippet}
</Story>

<!--
  Figma ships Theme=Light and Theme=Dark symbols. Rather than a `theme` prop, the
  component leans on `light-dark()`; forcing `color-scheme` shows both at once.
 -->
<Story name="Themes">
  {#snippet template(args)}
    <div class="flex gap-4">
      {#each ['light', 'dark'] as scheme}
        <div
          style="color-scheme: {scheme}"
          class="flex items-center gap-3 rounded p-4 {scheme === 'light' ? 'bg-white' : 'bg-zinc-900'}"
        >
          <Button>Finish Review</Button>
          <Button variant="secondary">Add comment</Button>
          <Button variant="action">Mark Group as Reviewed</Button>
        </div>
      {/each}
    </div>
  {/snippet}
</Story>

<Story name="Disabled">
  {#snippet template(args)}
    <Button disabled>Finish Review</Button>
  {/snippet}
</Story>
