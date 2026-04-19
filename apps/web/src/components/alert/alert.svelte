<script lang="ts" module>
import { cva, type VariantProps } from 'class-variance-authority';

const variants = cva('', {
	variants: {
		variant: {
			error: 'bg-error-token text-on-error-token border-on-error-token',
			warning: 'bg-warning-token text-on-warning-token border-on-warning-token',
			success: 'bg-emerald-400 text-emerald-900',
		},
	},
	defaultVariants: {
		variant: 'error',
	},
});

export type AlertVariantProps = VariantProps<typeof variants>;
export type AlertProps = {
	children: Snippet<[]>;
	onclose?: () => void;
} & AlertVariantProps;
</script>
<script lang="ts">
  import { XIcon } from 'lucide-svelte';
  import type { Snippet } from 'svelte';

  let { children, variant, onclose = () => void 0 }: AlertProps = $props();
  const classes = $derived(variants({ variant }));
</script>

<div class={['rounded-xl border py-3 px-4 flex justify-between', classes]} >

  <div>
    {@render children?.()}
  </div>

  <button type="button" class="xs hover text-inherit" onclick={() => onclose()}>
    <XIcon size="1em"/>
  </button>
</div>