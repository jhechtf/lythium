<script lang="ts">
  import { CircleUserRoundIcon, SettingsIcon, InboxIcon, MessageSquareDiffIcon } from 'lucide-svelte';
	import Stack from '../stack/stack.svelte';
</script>
<div class="rail">
	<div class="top">
    <Stack direction="column" gap="md">
      <a class="no" href="/">
        <CircleUserRoundIcon aria-details="User details" width="100%" />
      </a>
      <a href="/inbox">
        <InboxIcon aria-details="Inbox" width="100%" />
      </a>
      <MessageSquareDiffIcon aria-details="User details" width="100%" />
      <CircleUserRoundIcon aria-details="User details" width="100%" />
      <hr />
      <CircleUserRoundIcon aria-details="User details" width="100%" />
    </Stack>
  </div>
  <div class="bottom">
    <Stack direction="column" gap="md">
      <hr />
      <a href="/settings">
        <SettingsIcon aria-details="Settings" width="100%"/>
      </a>
    </Stack>
  </div>
</div>

<style>

  hr {
    color: rgb(from currentColor r g b / 0.3);
  }

	.rail {
		display: flex;
		flex-direction: column;
    align-items: center;
		flex-grow: 1;
    height: auto;
		background-color: var(--color-zinc-800);
		max-width: 48px;
		margin: 0;
		gap: calc(var(--spacing) * 4);
    & > * {
      &:first-child {
        padding-top: calc(var(--spacing) * 5);
      }
      padding: calc(var(--spacing) * 3);
      &:last-child {
        padding-bottom: calc(var(--spacing) * 4);
      }
    }

    .top {
      flex-grow: 1;
      overflow: auto;
    }
	}
</style>
