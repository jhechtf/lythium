<script lang="ts" module>
import { defineMeta } from '@storybook/addon-svelte-csf';
import SidebarItem from './sidebarItem.svelte';

const { Story } = defineMeta({
	component: SidebarItem,
	args: {
		status: 'pending',
		label: 'Group Name',
		count: 3,
		theme: 'auto',
	},
	argTypes: {
		status: {
			control: 'inline-radio',
			options: ['reviewed', 'current', 'pending'],
		},
		theme: { control: 'inline-radio', options: ['auto', 'light', 'dark'] },
	},
	tags: ['autodocs'],
});

const statuses = ['reviewed', 'current', 'pending'] as const;
const themes = ['light', 'dark'] as const;
</script>

<!-- A pending group. -->
<Story name="Pending" args={{ status: 'pending' }} />

<!-- The group currently under review. -->
<Story name="Current" args={{ status: 'current' }} />

<!-- A fully reviewed group. -->
<Story name="Reviewed" args={{ status: 'reviewed' }} />

<!-- The full Status x Theme matrix (six variants), with the theme forced per column. -->
<Story name="Matrix">
  {#snippet template()}
    <div class="flex gap-4">
      {#each themes as theme (theme)}
        <div
          class="flex w-56 flex-col gap-1 rounded p-3 {theme === 'dark' ? 'bg-zinc-900' : 'bg-white'}"
        >
          {#each statuses as status (status)}
            <SidebarItem {status} {theme} label="Group Name" count={3} />
          {/each}
        </div>
      {/each}
    </div>
  {/snippet}
</Story>

<!-- A long label truncates with an ellipsis; the count badge stays intact. -->
<Story name="Long label">
  {#snippet template()}
    <div class="w-56">
      <SidebarItem
        status="current"
        label="A very long review group name that cannot possibly fit on one line"
        count={128}
      />
    </div>
  {/snippet}
</Story>
