<script lang="ts">
import '../app.css';
import favicon from '$lib/assets/favicon.svg';
import Rail from '../components/rail/rail.svelte';
import Command from '../components/command/command.svelte';
import ToastPortal from '$components/toast/toastPortal.svelte';

let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<Command />
<ToastPortal />

<div class="flex min-h-screen max-h-max">
  <Rail />
  {@render children?.()}
</div>
