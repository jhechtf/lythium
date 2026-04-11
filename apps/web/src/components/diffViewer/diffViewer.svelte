<script lang="ts">
import { parse } from 'diff2html';
import { ChevronDownIcon, ChevronUpIcon, MessageSquareIcon } from 'lucide-svelte';
import Checkbox from '$components/checkbox/checkbox.svelte';
import Expandable from '$components/expandable/expandable.svelte';
import 'diff2html/bundles/css/diff2html.min.css';
import 'highlight.js/styles/github-dark.css';
import type { DiffFile } from '@lythium/api/types';
import type { DiffLine, DiffLineContent, DiffLineContext, DiffLineDeleted, DiffLineInserted } from 'diff2html/lib/types';
import highlight from 'highlight.js';

let { file }: { file: DiffFile } = $props();

const displayName = $derived(
	file.previous_filename ? `${file.previous_filename} → ${file.filename}` : file.filename,
);

type WithDiffContent<T> = T & DiffLineContent;

const parsed = $derived.by( () => {
  if(!file.patch) return null;
  
  const raw =  parse(
    `--- a/${file.previous_filename ?? file.filename}\n+++ b/${file.filename}\n${file.patch}`,
    {outputFormat: 'side-by-side'}
  ).flatMap(b => b.blocks.flatMap(bb => bb.lines))
  .reduce((all, cur, _, arr) => {
      console.info(arr);
      if(cur.type === 'context') {
        all.left.push(cur);
        const clone = Object.assign({}, cur,  { clone: true })
        all.right.push(clone);
      }
      if (cur.type === 'delete') {
        all.left.push(cur);
      }
      if(cur.type === 'insert') {
        all.right.push(cur);
      }
      if(_ === arr.length) {
        all.left.sort((a, b) => a.oldNumber - b.oldNumber);
        all.right.sort((a, b) => a.newNumber - b.newNumber);
      }

      return all;
    }, { left: [], right: [] } as { left: WithDiffContent<DiffLineDeleted | DiffLineContext>[]; right: WithDiffContent<DiffLineInserted | DiffLineContext>[]});

  const merged: (DiffLine & { clone?: true })[] = [];

  for(let i = 0; i < Math.max(raw.left.length, raw.right.length); i++) {
    const l = raw.left[i];
    const r = raw.right[i];
    if(l) {
      merged.push(l);
    }
    if(r) {
      merged.push(r);
    }
  }
  return merged;
}
);

</script>

<Expandable
	open
	class="my-4 rounded-lg border border-zinc-400 not-open:*:first:rounded-lg open:*:first:rounded-t-lg overflow-hidden"
	summaryClasses="bg-zinc-600 sticky top-0 px-4 py-3"
>
	{#snippet header({ open })}
		<div class="flex justify-between">
			<div class="flex items-center gap-2">
				{#if open}
					<ChevronUpIcon size="1em" />
				{:else}
					<ChevronDownIcon size="1em" />
				{/if}
				{displayName}
				<span class="text-sm text-zinc-400">
					+{file.additions} -{file.deletions}
				</span>
			</div>

			<div class="action flex items-center gap-2">
				<Checkbox name="viewed[{file.filename}]">Viewed</Checkbox>

				<button type="button" class="custom rounded-full p-1 text-blue-400 hover:bg-zinc-800">
					<MessageSquareIcon size="1em" />
				</button>
			</div>
		</div>
	{/snippet}

  <div class="diff-wrap">
    {#if parsed}
      {#each parsed as line}
        {@const side = line.type === 'delete' || (line.type === 'context' && !line.clone) ? 'left': 'right'}
        <div class={["line-number", line.type]} data-diff-view={side}>
          {#if line.clone}
            {line.newNumber}
          {:else}
            {line.oldNumber || line.newNumber}
          {/if}
        </div>
        <div class={['line-content', line.type]} data-diff-view={side}>
          <pre>{line.content.replace(/^[-+]/, '')}</pre>
        </div>
      {/each}
    {/if}
  </div>

</Expandable>

<style>
  .diff-wrap:has([data-diff-view="right"]:hover) [data-diff-view="left"],
  .diff-wrap:has([data-diff-view="left"]:hover) [data-diff-view="right"] {
    user-select: none;
  }

  .line-content pre {
    white-space: pre-wrap;
    word-break: break-all;
  }

  .diff-wrap {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    display: grid;
    grid-template-columns: max-content 1fr min-content 1fr;

    .line-content {
      padding-inline: 0.5rem;
    }


    .line-number {
      padding-inline: 0.5rem;
      border-inline: 1px solid pink;
      user-select: none;
    }

    .line-number.delete {
      grid-column-start: 1;
    }
    .line-number.insert,
    .line-number[data-diff-view="right"] {
      grid-column-start: 3;
    }
    
  }
  .diff-wrap .context {
    background-color: var(--color-zinc-700);
  }
  .diff-wrap .delete {
    background-color: color-mix(transparent 50%, lightcoral);
  }
  .diff-wrap .insert {
    background-color: color-mix(transparent 50%, lightgreen 60%);
  }
	/* Scope diff2html styles and override for dark theme */
	</style>
