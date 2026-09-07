<script lang="ts" module>
import { defineMeta } from '@storybook/addon-svelte-csf';
import DiffStats from '../diffStats/diffStats.svelte';
import TreeItem from './treeItem.svelte';

const { Story } = defineMeta({
	component: TreeItem,
	args: {
		type: 'file',
		name: 'admin.ts',
		selected: false,
		expanded: false,
		depth: 0,
	},
	argTypes: {
		type: { control: 'inline-radio', options: ['folder', 'file'] },
	},
	tags: ['autodocs'],
});
</script>

<!-- A file row in the default (unselected) state. -->
<Story name="File" args={{ type: 'file', name: 'admin.ts' }} />

<!-- A file row in the selected state. -->
<Story name="File selected" args={{ type: 'file', name: 'admin.ts', selected: true }} />

<!-- A collapsed folder row. -->
<Story name="Folder" args={{ type: 'folder', name: 'src' }} />

<!-- An expanded, selected folder row — chevron rotated, open-folder glyph. -->
<Story
  name="Folder expanded selected"
  args={{ type: 'folder', name: 'src', expanded: true, selected: true }}
/>

<!--
  The full Type x State matrix. Theme=Light / Theme=Dark are handled by
  `light-dark()`, so the same markup is shown under forced `color-scheme`.
 -->
<Story name="Matrix">
  {#snippet template()}
    <div class="flex gap-4">
      {#each ['light', 'dark'] as scheme (scheme)}
        <div
          style="color-scheme: {scheme}"
          class="flex w-56 flex-col gap-1 rounded p-3 {scheme === 'dark'
            ? 'bg-zinc-900'
            : 'bg-white'}"
        >
          <TreeItem type="folder" name="src" expanded />
          <TreeItem type="folder" name="components" />
          <TreeItem type="file" name="index.ts" depth={1} />
          <TreeItem type="file" name="admin.ts" depth={1} selected />
        </div>
      {/each}
    </div>
  {/snippet}
</Story>

<!--
  A nested tree built from stacked rows, using `depth` for indentation.
 -->
<Story name="Nested tree">
  {#snippet template()}
    <div class="flex w-64 flex-col gap-0.5">
      <TreeItem type="folder" name="apps" expanded />
      <TreeItem type="folder" name="web" depth={1} expanded />
      <TreeItem type="file" name="app.css" depth={2} />
      <TreeItem type="file" name="+layout.svelte" depth={2} selected />
      <TreeItem type="folder" name="packages" />
    </div>
  {/snippet}
</Story>

<!--
  The `children` snippet renders trailing content — here a `<DiffStats />`.
 -->
<Story name="With trailing stats">
  {#snippet template()}
    <div class="flex w-72 flex-col gap-0.5">
      <TreeItem type="file" name="badge.svelte" depth={1}>
        <DiffStats additions={24} deletions={3} />
      </TreeItem>
      <TreeItem type="file" name="badge.stories.svelte" depth={1} selected>
        <DiffStats additions={8} deletions={12} />
      </TreeItem>
    </div>
  {/snippet}
</Story>
