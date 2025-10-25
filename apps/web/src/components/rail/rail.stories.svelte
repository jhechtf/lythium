<script lang="ts" module>
	import { defineMeta } from "@storybook/addon-svelte-csf";
  import Rail from "./rail.svelte";

  const { Story } = defineMeta({
    component: Rail,
    tags: ['autodocs'],
  });
</script>

<Story name="Default" />