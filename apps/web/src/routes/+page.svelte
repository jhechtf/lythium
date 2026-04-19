<script lang="ts">
import Stack from '../components/stack/stack.svelte';

let { data } = $props();
const stuff = $derived(await data.results);
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
    {#each stuff.data.items as st (st.id)}
    <a href="/pr/github/{data.owner}/{data.repo}/{st.number}">
      <article class="bg-surface-token text-on-surface-token rounded-xl p-3">
        <header class="text-lg font-semibold mb-4">
          {st.title}
          <small class="text-zinc-300">
          </small>
        </header>
        <div>
          <pre>
            {JSON.stringify(st, null, 2)}
          </pre>
          <Stack class="items-center" gap="sm">
            {#if st.user}
              <img src={st.user.avatar_url} alt={`${st.user.login} icon`} class="rounded-full h-[1.25em] w-[1.25em]" />
              {st.user.login}
            {/if}
          </Stack>
        </div>
      </article>
    </a>
    {/each}
	</Stack>
</div>
