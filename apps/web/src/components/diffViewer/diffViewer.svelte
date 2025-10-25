<script lang="ts">
import {
	ChevronUpIcon,
	ChevronDownIcon,
	MessageSquareIcon,
} from 'lucide-svelte';
import Checkbox from '$components/checkbox/checkbox.svelte';
import Expandable from '$components/expandable/expandable.svelte';

const diff = Array.from({ length: 50 });
</script>

<Expandable
		open
		class="my-4 rounded-lg border border-zinc-400 *:px-3 *:py-2 not-open:*:first:rounded-lg open:*:first:rounded-t-lg"
		summaryClasses="bg-zinc-600 sticky top-0"
	>
		{#snippet header({ open })}
			<div class="flex justify-between">
				<div class="flex items-center gap-2">
					{#if open}
						<ChevronUpIcon size="1em" />
					{:else}
						<ChevronDownIcon size="1em" />
					{/if}
					src/file/name.ts
				</div>

				<div class="action flex items-center gap-2">
					<Checkbox name="viewed[file-id]" checked>Viewed</Checkbox>

					<button class="custom rounded-full p-1 text-blue-400 hover:bg-zinc-800">
						<MessageSquareIcon size="1em" />
					</button>
				</div>
			</div>
		{/snippet}
		<div class="flex flex-col gap-2">
			{#each diff}
				<div class="flex">
					<div class="flex-1 bg-green-300/30 py-1">hello you</div>
					<div class="flex-1 bg-red-500/40 py-1">fuck you</div>
				</div>
			{/each}
		</div>
	</Expandable>