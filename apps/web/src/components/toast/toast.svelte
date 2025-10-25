<script lang="ts" module>
export type ToastProps = {
	position?: ToastPosition;
	children: Snippet<[]>;
  autodismiss?: number;
};
</script>
<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
  import { registerToast, type ToastPosition } from './toastState.svelte';

  let { children, position = 'bottom-right', autodismiss = 0 }: ToastProps = $props();
  let id = $props.id();

  onMount(() => {
    const obj = {
      content: children,
      show: true,
      dismissAfter: autodismiss,
      position,
      id
    };

    const unreg = registerToast(obj);

    return unreg;

  });
</script>
