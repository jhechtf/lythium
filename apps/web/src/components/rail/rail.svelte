<script lang="ts">
import {
	CircleUserRoundIcon,
	InboxIcon,
	MessageSquareDiffIcon,
	SettingsIcon,
} from 'lucide-svelte';
import Stack from '../stack/stack.svelte';
</script>
<div class="rail">
	<div class="top">
    <Stack direction="column" gap="md">
      <a class="no" href="/">
        <div class="sr-only">User Profile</div>
        <CircleUserRoundIcon aria-details="User details" width="100%" />
      </a>
      <a href="/inbox">
        <div class="sr-only">Inbox</div>
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
        <span class="sr-only">Settings</span>
        <SettingsIcon aria-details="Settings" width="100%"/>
      </a>
    </Stack>
  </div>
</div>

<style>
  @reference '#app.css';

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
		gap: --spacing(4);
    & > * {
      padding: --spacing(3);
      &:first-child {
        padding-top: --spacing(5);
      }
      &:last-child {
        padding-bottom: --spacing(4);
      }
    }

    .top {
      flex-grow: 1;
      overflow: auto;
    }
	}
</style>
