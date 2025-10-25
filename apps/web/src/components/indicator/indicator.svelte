<script lang="ts" module>
import { cva, type VariantProps } from 'class-variance-authority';

const classFn = cva('', {
	variants: {
		type: {
			success: 'bg-emerald-400',
			pending: 'bg-amber-300',
			error: 'bg-red-400',
		},
	},
});

export type IndicatorVariants = VariantProps<typeof classFn>;
export type IndicatorProps = IndicatorVariants & {
	inProgress?: boolean;
};
</script>
<script lang="ts">
  let { type = 'pending', inProgress = false }: IndicatorProps = $props();
  const classes = $derived(classFn({ type }));
</script>

<div
  class={["h-2 w-2 rounded-full", classes, { 'animate-pulse': inProgress}]}
></div>
