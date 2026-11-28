import { describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import '../../app.css';
import SidebarItem from './sidebarItem.svelte';

const statuses = ['reviewed', 'current', 'pending'] as const;
const themes = ['light', 'dark'] as const;

describe('SidebarItem', () => {
  for (const status of statuses) {
    for (const theme of themes) {
      it(`renders ${status} / ${theme} with an accessible name and status`, async () => {
        render(SidebarItem, { status, theme, label: 'Backend', count: 3 });
        const name = `Backend ${status[0].toUpperCase()}${status.slice(1)} 3`;
        const btn = page.getByRole('button', { name });
        await expect.element(btn).toBeInTheDocument();
        await expect.element(btn).toHaveAttribute('type', 'button');
        if (status === 'current') {
          await expect.element(btn).toHaveAttribute('aria-current', 'true');
        } else {
          await expect.element(btn).not.toHaveAttribute('aria-current');
        }
      });
    }
  }

  it('renders a count of 0', async () => {
    render(SidebarItem, { label: 'Empty', count: 0 });
    await expect
      .element(page.getByRole('button', { name: 'Empty Pending 0' }))
      .toBeInTheDocument();
  });

  it('activates on click and via keyboard', async () => {
    const onclick = vi.fn();
    render(SidebarItem, { label: 'Backend', count: 1, onclick });
    await page.getByRole('button').click();
    expect(onclick).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Enter}');
    expect(onclick).toHaveBeenCalledTimes(2);
    await userEvent.keyboard(' ');
    expect(onclick).toHaveBeenCalledTimes(3);
  });

  it('shows a visible focus ring on keyboard focus', async () => {
    render(SidebarItem, { label: 'Backend', count: 1 });
    await userEvent.tab();
    const el = page.getByRole('button').element();
    expect(document.activeElement).toBe(el);
    const style = getComputedStyle(el);
    expect(style.outlineStyle).toBe('solid');
    expect(Number.parseFloat(style.outlineWidth)).toBeGreaterThan(0);
  });

  it('applies the Figma theme colors for current', async () => {
    render(SidebarItem, {
      status: 'current',
      theme: 'light',
      label: 'Backend',
      count: 3,
    });
    const el = document.querySelector('button') as HTMLElement;
    const light = getComputedStyle(el);
    expect(light.backgroundColor).toBe('rgb(239, 246, 255)');
    expect(light.borderTopColor).toBe('rgb(226, 232, 240)');
    expect(light.color).toBe('rgb(37, 99, 235)');
    expect(light.borderRadius).toBe('8px');

    render(SidebarItem, {
      status: 'current',
      theme: 'dark',
      label: 'Dark',
      count: 3,
    });
    const dark = document.querySelector(
      '.sidebar-item[data-theme="dark"]',
    ) as HTMLElement;
    const d = getComputedStyle(dark);
    expect(d.backgroundColor).toBe('rgb(31, 41, 55)');
    expect(d.color).toBe('rgb(88, 166, 255)');
    const badge = dark.querySelector('.badge') as HTMLElement;
    expect(getComputedStyle(badge).backgroundColor).toBe('rgb(33, 136, 255)');
  });

  it('shows the matching current icon per theme', async () => {
    render(SidebarItem, {
      status: 'current',
      theme: 'dark',
      label: 'Backend',
      count: 3,
    });
    const dark = document.querySelector('.sidebar-item__icon--dark');
    const light = document.querySelector('.sidebar-item__icon--light');
    expect(getComputedStyle(dark as Element).display).toBe('block');
    expect(getComputedStyle(light as Element).display).toBe('none');
  });

  it('truncates a long label without wrapping the count', async () => {
    render(SidebarItem, {
      label:
        'A very long review group name that cannot possibly fit on one line',
      count: 128,
      class: 'w-56',
    });
    const label = document.querySelector('.sidebar-item__label') as HTMLElement;
    expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
    const badge = document.querySelector('.badge') as HTMLElement;
    expect(badge.getBoundingClientRect().height).toBeLessThan(24);
  });
});
