import type { Snippet } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';

/**
 * The positions are set to one of the six
 */
export type ToastPosition =
  | 'top'
  | 'top-left'
  | 'top-right'
  | 'bottom'
  | 'bottom-left'
  | 'bottom-right';

export type ToastObject = {
  content: Snippet<[]>;
  show: boolean;
  dismissAfter: number;
  id: string;
  position?: ToastPosition;
};

/**
 * The Toasts object. Currently a set until such time I feel it necessary to
 * change it to something else.
 */
export const toasts = new SvelteSet<ToastObject>();

export function registerToast(toast: ToastObject): () => void {
  toasts.add(toast);
  return () => toasts.delete(toast);
}
