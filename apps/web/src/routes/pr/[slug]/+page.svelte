<script lang="ts">
import DiffViewer from '$components/diffViewer/diffViewer.svelte';
import Expandable from '$components/expandable/expandable.svelte';
import Header from '$components/header/header.svelte';
import Toast from '$components/toast/toast.svelte';
import Indicator from '$components/indicator/indicator.svelte';
import {
	FileIcon,
	FolderClosedIcon,
	FolderOpenIcon,
	TriangleIcon,
} from 'lucide-svelte';
</script>

<svelte:head>
  <title>PR - feat: Update thing to be thingy</title>
</svelte:head>

<Toast autodismiss={4}>
  <div class="font-bold">faslkdjflajslk</div>
</Toast>
<Toast autodismiss={3}>
  <div class="font-bold">flaksdflkaj</div>
</Toast>

<div class="mx-4 my-3 w-1/8 rounded-lg border *:px-3 *:py-2">
	<input type="search" placeholder="Search for files" class="w-full" />
	<ul class="list-none **:[ul]:border-l **:[ul]:pl-3">
		<li>
			<div class="inline-flex items-center gap-2">
				<FolderOpenIcon size="1em" />
				src/
			</div>
			<ul class="ml-4">
				<li>
					<div class="inline-flex items-center gap-2">
						<FolderOpenIcon size="1em" />
						file/
					</div>
					<ul class="ml-4">
						<div class="inline-flex items-center gap-2">
							<FileIcon size="1em" />
							<li>name.ts</li>
						</div>
					</ul>
				</li>
			</ul>
		</li>
		<li>
			<div class="inline-flex items-center gap-2">
				<FolderClosedIcon size="1em" />
				closed/
			</div>
		</li>
	</ul>
</div>

<div class="flex-1 p-4">
	<div class="card my-8 rounded-xl border p-4">
		<div class="flex gap-4">
			<div class="flex items-center gap-2">
        <img src="https://avatars.githubusercontent.com/u/8152471?v=4" alt="Jhecht profile" class="h-6 w-6 rounded-full">
				jhechtf
			</div>
			<span class="text-zinc-400">burbridge-lol#13</span>
		</div>

		<Header tag="h3">feat: Update thing to be the thingy</Header>
		<Expandable class="mt-8">
			{#snippet header({ open })}
				<div class="flex items-center gap-2">
					<TriangleIcon size="1em" class={open ? 'rotate-180' : 'rotate-90'} />
					Description
				</div>
			{/snippet}
			<div class="p-4">
				<h2>Why?</h2>
				<p>I am the rendered thingamajig.</p>
				<p>Suck my balls, Mr. Garrison</p>
			</div>
		</Expandable>
	</div>

  <table class="table-fixed">
    <thead>
      <tr>
        <th></th>
        <th>Name</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      <tr class="*:p-2 even:bg-zinc-400">
        <td>
          <Indicator inProgress/>
        </td>
        <td>
          something/bob is cool
        </td>
        <td></td>
      </tr>
    </tbody>
  </table>

  <DiffViewer />
  <DiffViewer />
  <DiffViewer />
  <DiffViewer />
</div>

<div class="mx-4 w-1/6 p-3">
	<h6>Reviewers</h6>
	<ul class="ml-4">
		<li>Lorem.</li>
		<li>Possimus.</li>
	</ul>
	<h6 class="mt-4">Assignees</h6>
	<ul class="ml-4">
		<li>Jim Burbridge (You)</li>
	</ul>
</div>
