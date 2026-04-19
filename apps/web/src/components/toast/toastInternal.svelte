<script lang="ts" module>
  import type { ToastObject } from "./toastState.svelte";
  
  export type ToastInternalProps = {
    toast: ToastObject;
  };
</script>
<script lang="ts">
  import { XIcon } from 'lucide-svelte';
	import { onMount } from "svelte";
  import { fly } from 'svelte/transition';
  import { toasts } from './toastState.svelte';

  let { toast }: ToastInternalProps = $props();

  onMount(() => {
    if (toast.dismissAfter > 0) {
      const timer = setTimeout(() => {
        toasts.delete(toast);
      }, toast.dismissAfter * 1000);

      return () => {
        clearTimeout(timer);
      }
    }
  });
</script>

<div out:fly class="border rounded-2xl p-3 overflow-hidden bg-surface-token text-on-surface-token" >
  {#if toast.dismissAfter}
    <div class="h-4 border rounded-t-2xl bg-blue-500" style:transition={`translate ${toast.dismissAfter}s linear`}></div>
  {/if}
  <button type="button" class="hover sm" onclick={() => toasts.delete(toast)}>
    <XIcon size="1em"/>
  </button>

  {@render toast.content()}
</div>
