<script lang="ts">
	import { ChevronDownIcon, ChevronUpIcon, MessageSquare, MessageSquareIcon } from 'lucide-svelte';
	import Checkbox from '../../../components/checkbox/checkbox.svelte';
	import Expandable from '../../../components/expandable/expandable.svelte';
	import Header from '../../../components/header/header.svelte';

	const diff = Array.from({ length: 50 });
</script>

<div class="flex-1 p-4">
	<div class="card m-8 rounded-xl border p-4">
		<span class="text-zinc-400">burbridge-lol#13</span>
		<Header tag="h3">feat: Update thing to be the thingy</Header>
		<div class="flex items-center gap-2">
			<div class="h-6 w-6 rounded-full bg-zinc-500"></div>
			jhechtf
		</div>
	</div>
  
  <div class="m-8">
    description
    <div class="border rounded-lg p-4 mt-4">
      <h2>Why?</h2>
      <p>I am the rendered thingamajig. </p>
      <p>Suck my balls, Mr. Garrison</p>
    </div>
  </div>


	<Expandable
    open
		class="my-4 rounded-lg border border-zinc-400 *:px-3 *:py-2 not-open:*:first:rounded-lg open:*:first:rounded-t-lg"
		summaryClasses="bg-zinc-600"
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

        <div class="action flex gap-2 items-center">

          <Checkbox name="viewed[file-id]" checked>
            Viewed
          </Checkbox>

          <button class="custom text-blue-400 hover:bg-zinc-800 rounded-full p-1">
            <MessageSquareIcon size="1em"/>
          </button>
        </div>
      </div>
		{/snippet}
		<div class="flex flex-col gap-2">
			{#each diff}
				<div class="flex">
					<div class="flex-1 bg-green-300/30 py-1">hello you</div>
					<div class="flex-1 py-1">fuck you</div>
				</div>
			{/each}
		</div>
	</Expandable>


</div>
