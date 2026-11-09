<script lang="ts" module>
import type { Snippet } from 'svelte';
import type { ClassValue, HTMLButtonAttributes } from 'svelte/elements';

export type ButtonProps = Omit<HTMLButtonAttributes, 'class' | 'children'> & {
  children?: Snippet<[]>;
  class?: ClassValue;
  variant?: 'primary' | 'secondary' | 'action';
};
</script>

<script lang="ts">
  let {
    children,
    class: className,
    variant = 'primary',
    type = 'button',
    ...rest
  }: ButtonProps = $props();
</script>

<button {type} class={['button', variant, className]} {...rest}>
  {@render children?.()}
</button>

<style>
  .button {
    /* Figma "Button" (node 26:26): Theme=Light / Theme=Dark collapsed onto light-dark(). */
    --bg-color: var(--background-color, light-dark(#2563eb, #1f6feb));
    --fg-color: var(--text-color, light-dark(var(--color-white), var(--color-white)));
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.5rem 1rem;
    border: 0;
    border-radius: var(--radius-md);
    background-color: var(--bg-color);
    color: var(--fg-color);
    font-size: var(--text-sm);
    font-weight: var(--font-weight-semibold);
    line-height: normal;
    white-space: nowrap;
    cursor: pointer;

    &:focus-visible {
      outline: 2px solid var(--bg-color);
      outline-offset: 2px;
    }

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    &.secondary {
      --bg-color: var(--background-color, light-dark(#0f172a, #c9d1d9));
      --fg-color: var(--text-color, light-dark(var(--color-white), #0f1115));
      padding: 0.375rem 0.75rem;
      font-size: 13px;
    }

    &.action {
      --bg-color: var(--background-color, light-dark(#0f172a, #c9d1d9));
      --fg-color: var(--text-color, light-dark(var(--color-white), #0f1115));
      padding: 0.75rem 1.5rem;
      border-radius: var(--radius-lg);
    }
  }
</style>
