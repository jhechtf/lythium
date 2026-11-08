<script lang="ts" module>
import { defineMeta } from '@storybook/addon-svelte-csf';
import Badge from './badge.svelte';

const { Story } = defineMeta({
	component: Badge,
	args: {
		children: template,
	},
	tags: ['autodocs'],
});
</script>

{#snippet template()}
  3
{/snippet}

<!--
  The default Badge matches the Figma "Badge" component: a neutral count pill with
  a slate surface in light mode and a dark canvas surface in dark mode.
 -->
<Story name="Default" />

<!--
  Semantic variants. Colours are resolved with `light-dark()` so each adapts to the
  active theme automatically.
 -->
<Story name="Variants">
  {#snippet template(args)}
    <div class="flex gap-2">
      <Badge>3</Badge>
      <Badge variant="success">+12</Badge>
      <Badge variant="error">4</Badge>
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
      <div style="color-scheme: light" class="rounded bg-white p-4">
        <Badge>3</Badge>
      </div>
      <div style="color-scheme: dark" class="rounded bg-zinc-900 p-4">
        <Badge>3</Badge>
      </div>
    </div>
  {/snippet}
</Story>

<!--
  Custom colours via the `--background-color` / `--text-color` custom properties.
 -->
<Story name="Custom Colors">
  {#snippet template(args)}
    <Badge --background-color="orange" --text-color="black">
      37
    </Badge>
  {/snippet}
</Story>

<!--
  The `class` prop overrides the default padding / sizing.
 -->
<Story name="Sizing mods">
  {#snippet template(args)}
    <Badge class="px-4 py-3 text-lg font-semibold">
      66
    </Badge>
  {/snippet}
</Story>
