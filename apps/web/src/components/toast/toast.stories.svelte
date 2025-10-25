<script lang="ts" module>
import { defineMeta } from '@storybook/addon-svelte-csf';
import Toast from './toast.svelte';
import ToastPortal from './toastPortal.svelte';

const { Story } = defineMeta({
	component: ToastPortal,
  subcomponents: {
    Toast
  },
});

</script>

{#snippet template()}
<ToastPortal />
  <Toast>
    Hello
  </Toast>
{/snippet}

<!-- The Toast Component ***REQUIRES*** a `<ToastPortal>` component, or something other kind
 of component that pulls from the `toastState.svelte.ts` file. -->
<Story name="Default" {template} />

<Story name="Multiple in same region">
  {#snippet template(args)}
    <ToastPortal />
    <Toast>1</Toast>
    <Toast>2</Toast>
  {/snippet}
</Story>

<Story name="Multiple in different regions">
  {#snippet template()}
    <ToastPortal />

    <h2>Other content to show that these are floating</h2>
    <Toast position="bottom-left">1</Toast>
    <Toast>2</Toast>
    <Toast position="bottom">3</Toast>

    <Toast position="top-left" autodismiss={1}>4</Toast>
    <Toast position="top-left">4 pt 2</Toast>
    <Toast position="top-left" autodismiss={4}>4 pt 3</Toast>

    <Toast position="top-right">6</Toast>
    <Toast position="top">5</Toast>
  {/snippet}
</Story>