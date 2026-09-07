<script lang="ts" module>
import { defineMeta } from '@storybook/addon-svelte-csf';
import DiffStats from './diffStats.svelte';

const { Story } = defineMeta({
	component: DiffStats,
	args: {
		additions: 12,
		deletions: 4,
	},
	tags: ['autodocs'],
});
</script>

<!-- Matches the Figma "Diff Stats" component: a green "+added" figure next to a red "−removed" figure. -->
<Story name="Default" />

<!-- Only additions. -->
<Story name="Additions only" args={{ additions: 27, deletions: 0 }} />

<!-- Only deletions. -->
<Story name="Deletions only" args={{ additions: 0, deletions: 9 }} />

<!--
  `hideZero` drops whichever figure is 0 — useful for compact file rows.
 -->
<Story name="Hide zero" args={{ additions: 5, deletions: 0, hideZero: true }} />

<!--
  Figma ships Theme=Light and Theme=Dark symbols; the component uses `light-dark()`
  instead of a `theme` prop. Forcing `color-scheme` shows both.
 -->
<Story name="Themes">
  {#snippet template(args)}
    <div class="flex gap-4">
      <div style="color-scheme: light" class="rounded bg-white p-4">
        <DiffStats {...args} />
      </div>
      <div style="color-scheme: dark" class="rounded bg-zinc-900 p-4">
        <DiffStats {...args} />
      </div>
    </div>
  {/snippet}
</Story>
