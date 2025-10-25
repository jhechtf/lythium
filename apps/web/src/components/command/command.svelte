<script lang="ts" module>
	export type CommandProps = {
		show?: boolean;
	};
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { on } from 'svelte/events';
	import { commands } from './command.svelte.js';

	let { show = $bindable(false) }: CommandProps = $props();
	let dialogEl: HTMLDialogElement;

	onMount(() => {
		const off = on(dialogEl, 'close', (e) => {
      show = false;
		});

		if (show) {
			dialogEl.showModal();
		}

		return () => {
			off();
		};
	});

  let search = $state('');

  $effect(() => {
    if(show) {
      dialogEl.showModal();
    }
  });

  const id1 = $props.id();

  const filteredResults = $derived(commands.entities.filter(([key, cmdDef]) => {
    return search === '' || key.includes(search) || cmdDef.title.includes(search);
  }));

	function searchKeydownHandler(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			console.info('Yo');
		}
	}
</script>

<svelte:body onkeydown={(e) => {
  if(e.key === 'k' && e.metaKey) {
    e.preventDefault();
    show = true;
  }
}} />

<dialog bind:this={dialogEl}>
	<header class="flex flex-col">
		<input
			type="text"
			autofocus
			placeholder="Search commands"
			class="input px-3 py-2"
			onkeydown={searchKeydownHandler}
      aria-haspopup="listbox"
      aria-autocomplete="list"
      aria-controls={id1}
      bind:value={search}
		/>
		<small class="px-4 py-2">You can use the arrow keys to move up or down in the list</small>
	</header>
	<div id={id1} class="results max-h-1/2 overflow-auto" role="menu" tabindex="0">
			{#each filteredResults as [command, info] (command)}
				<div role="menuitem" aria-label={info.title}>
					<header class="flex items-center justify-between">
						{#if info.icon}
							Icon
						{/if}
						<span class="font-semibold">{info.title}</span>
						<small class="actions">
							<kbd>cmd</kbd>
							<kbd>2</kbd>
						</small>
					</header>
					{#if info.description}
						<div class="text-sm font-extralight text-zinc-300">
							{info.description}
						</div>
					{/if}
				</div>
      {:else}
        <div class="text-center">
          No commands found.
        </div>
			{/each}
	</div>
</dialog>

<style>
	dialog {
		margin-inline: auto;
		margin-block: auto;
		border-radius: 8px;
	}

	dialog .results {
		padding: calc(var(--spacing) * 4);
		border-bottom-left-radius: 8px;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	dialog::backdrop {
		background-color: rgb(0 0 0 / 0.45);
	}
</style>
