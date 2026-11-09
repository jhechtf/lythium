import { page } from '@vitest/browser/context';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Button from './button.svelte';

const label = createRawSnippet(() => ({ render: () => '<span>Save</span>' }));

describe('Button', () => {
  it('renders children in a button defaulting to type=button and primary', async () => {
    render(Button, { children: label });
    const btn = page.getByRole('button', { name: 'Save' });
    await expect.element(btn).toBeInTheDocument();
    await expect.element(btn).toHaveAttribute('type', 'button');
    await expect.element(btn).toHaveClass('primary');
  });

  it('applies the variant class', async () => {
    render(Button, { children: label, variant: 'action' });
    await expect.element(page.getByRole('button')).toHaveClass('action');
  });

  it('forwards attributes such as disabled', async () => {
    render(Button, { children: label, disabled: true });
    await expect.element(page.getByRole('button')).toBeDisabled();
  });
});
