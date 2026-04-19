<script lang="ts">
import { FileIcon, FolderIcon, FolderOpenIcon, ChevronRightIcon } from 'lucide-svelte';
import type { DiffFile } from '@lythium/api/types';

let { files }: { files: DiffFile[] } = $props();

type FileNode = { type: 'file'; name: string; file: DiffFile };
type FolderNode = { type: 'folder'; name: string; children: TreeNode[] };
type TreeNode = FileNode | FolderNode;

function buildTree(files: DiffFile[]): TreeNode[] {
	const root: FolderNode = { type: 'folder', name: '', children: [] };
	for (const file of files) {
		const parts = file.filename.split('/');
		let current = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const part = parts[i];
			let child = current.children.find(
				(c): c is FolderNode => c.type === 'folder' && c.name === part,
			);
			if (!child) {
				child = { type: 'folder', name: part, children: [] };
				current.children.push(child);
			}
			current = child;
		}
		current.children.push({ type: 'file', name: parts[parts.length - 1], file });
	}
	return root.children;
}

const tree = $derived(buildTree(files));
let collapsed = $state<Record<string, boolean>>({});
</script>

{#snippet renderNodes(nodes: TreeNode[], depth: number, pathPrefix: string)}
	{#each nodes as node}
		{#if node.type === 'folder'}
			{@const fullPath = pathPrefix + node.name}
			{@const isOpen = !collapsed[fullPath]}
			<li>
				<button
					class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-zinc-700"
					style="padding-left: {depth * 12 + 4}px"
					onclick={() => {
						collapsed[fullPath] = !collapsed[fullPath];
					}}
				>
					<ChevronRightIcon
						size="0.75em"
						class="shrink-0 transition-transform {isOpen ? 'rotate-90' : ''}"
					/>
					{#if isOpen}
						<FolderOpenIcon size="0.875em" class="shrink-0 text-yellow-400" />
					{:else}
						<FolderIcon size="0.875em" class="shrink-0 text-yellow-400" />
					{/if}
					<span class="truncate font-mono">{node.name}</span>
				</button>
				{#if isOpen}
					<ul class="list-none">
						{@render renderNodes(node.children, depth + 1, fullPath + '/')}
					</ul>
				{/if}
			</li>
		{:else}
			<li>
				<div
					class="flex items-center gap-1 rounded px-1 py-0.5 text-xs hover:bg-zinc-700"
					style="padding-left: {depth * 12 + 20}px"
				>
					<FileIcon size="0.875em" class="shrink-0 text-zinc-400" />
					<span class="truncate font-mono text-zinc-300">{node.name}</span>
				</div>
			</li>
		{/if}
	{/each}
{/snippet}

<ul class="list-none p-1">
	{@render renderNodes(tree, 0, '')}
</ul>
