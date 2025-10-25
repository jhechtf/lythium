<script lang="ts">
  import Stack from '../components/stack/stack.svelte';
</script>

<svelte:head>
	<title>Slip</title>
</svelte:head>

<div class="flex-1 p-4 ">
  <h5>Hey</h5>
  <Stack direction="column">
    hi
  </Stack>
</div>

<div class="p-4 flex-6 ml-4">
	<Stack direction="column" gap="lg">
		{#each Array.from({ length: 20 })}
			<article
				class="bg-surface-token text-on-surface-token rounded-xl p-3"
			>
				<header>Testing 123</header>
				<div>Sup</div>
			</article>
		{/each}
	</Stack>
</div>
