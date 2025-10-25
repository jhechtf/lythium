<script lang="ts" module>
import type { Snippet } from 'svelte';
import type { ClassValue } from 'svelte/elements';

export type ModalProps = {
	open?: boolean;
	onclose?: () => void;
	children?: Snippet<[{ open: boolean; close: () => void }]>;
	class?: ClassValue;
};
</script>

<script lang="ts">
	let {
		open = $bindable(false),
		onclose = () => void 0,
		children,
		class: classValue = ''
	}: ModalProps = $props();

	let dialogEl: HTMLDialogElement | null = $state(null);
	$effect(() => {
		if (open && dialogEl) {
			dialogEl.showModal();
		}

		if (!open && dialogEl) {
			dialogEl.close();
			onclose();
		}
	});
</script>

<dialog
	bind:this={dialogEl}
	class={['rounded-2xl', classValue, 'shadow-sm shadow-amber-200/50']}
>
	{@render children?.({
		open,
		close: () => void 0
	})}
</dialog>

<style>
	dialog {
		margin: 0 auto;
		min-width: 20vw;
		min-height: 10vh;
		padding: calc(var(--spacing) * 4);
	}
	dialog::backdrop {
		background-color: rgb(from black r g b / 0.5);
	}
</style>
