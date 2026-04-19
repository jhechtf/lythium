<script lang="ts">
import { TriangleIcon } from 'lucide-svelte';
import DiffViewer from '$components/diffViewer/diffViewer.svelte';
import Expandable from '$components/expandable/expandable.svelte';
import FileTree from '$components/fileTree/fileTree.svelte';
import Header from '$components/header/header.svelte';

let { data } = $props();
</script>

<svelte:head>
  <title>{data.owner}/{data.repo} #{data.number}</title>
</svelte:head>

<div class="mx-4 my-3 w-1/8 rounded-lg border *:px-3 *:py-2">
	<input type="search" placeholder="Search for files" class="w-full" />
	<FileTree files={data.stack.flatMap((item) => item.diff.files)} />
</div>

<div class="flex-1 p-4">
	{#each data.stack as item}
		<div class="card my-8 rounded-xl border p-4">
			<div class="flex gap-4">
				<span class="text-zinc-400">{data.owner}/{data.repo}#{item.pr.number}</span>
			</div>

			<Header tag="h3">{item.pr.title}</Header>

			<div class="mt-2 text-sm text-zinc-400">
				<span class="font-mono">{item.pr.head.ref}</span>
				→
				<span class="font-mono">{item.pr.base.ref}</span>
				&nbsp;·&nbsp;
				{item.diff.stats.total_commits} commit{item.diff.stats.total_commits === 1 ? '' : 's'}
				&nbsp;·&nbsp;
				{item.diff.files.length} file{item.diff.files.length === 1 ? '' : 's'} changed
			</div>

			<Expandable class="mt-4">
				{#snippet header({ open })}
					<div class="flex items-center gap-2">
						<TriangleIcon size="1em" class={open ? 'rotate-180' : 'rotate-90'} />
						Description
					</div>
				{/snippet}
				<div class="p-4">
					<a href={item.pr.html_url} target="_blank" class="text-blue-400 underline">
						View on GitHub →
					</a>
				</div>
			</Expandable>
		</div>

		{#each item.diff.files as file}
			<DiffViewer {file} />
		{/each}
	{/each}
</div>

<div class="mx-4 w-1/6 p-3">
	<h6>Stack</h6>
	<ul class="ml-4 font-mono text-sm">
		{#each data.stack as item}
			<li class={item.pr.number === data.number ? 'font-bold text-white' : 'text-zinc-400'}>
				#{item.pr.number} {item.pr.head.ref}
			</li>
		{/each}
	</ul>
</div>
