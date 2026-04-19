<script lang="ts">
import { cva } from 'class-variance-authority';
import ToastInternal from './toastInternal.svelte';
import { type ToastObject, type ToastPosition, toasts } from './toastState.svelte';

// TODO: Would it make sense to make the toast export some kind of object and just do this
// in the state file itself?
const toastsByArea = $derived(
  toasts.values().reduce((all, cur) => {
    const pos = cur.position || 'bottom-right';
    if(!all[pos]) all[pos] = [];
    all[pos].push(cur);
    return all;
  },
    {} as Record<ToastPosition, ToastObject[]>
  )
);

const classes = cva('flex flex-col fixed gap-4', {
  variants: {
    position: {
      // bottoms
      'bottom-right': 'bottom-4 right-4',
      'bottom-left': 'bottom-4 left-4',
      bottom: 'bottom-4 left-1/2',

      // tops
      'top-right': 'top-4 right-4',
      'top-left': 'top-4 left-4',
      top: 'top-4 left-1/2'
    },
  },
  defaultVariants: {
    position: 'bottom-right'
  }
});

const locations: ToastPosition[] = [
  'bottom',
  'bottom-left',
  'bottom-right',
  'top',
  'top-left',
  'top-right'
];
</script>

<!-- The renders the actual toasts. -->
{#snippet renderToast(toast: ToastObject)}
  <ToastInternal toast={toast} />
{/snippet}

{#each locations as location}
  <div class={classes({position: location })}>
    {#each toastsByArea[location] as toast}
      {@render renderToast(toast)}
    {/each}
  </div>
{/each}
