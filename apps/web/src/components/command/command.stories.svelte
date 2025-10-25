<script lang="ts" module>
	import { defineMeta } from "@storybook/addon-svelte-csf";
  import Command from "./command.svelte";

  const { Story } = defineMeta({
    component: Command,
    args: {
      show: true,
    },
    tags: ['autodocs']
  });

</script>

<!-- There should only be one of these on the page, as they load from the commands store -->
<Story name="Default" />
