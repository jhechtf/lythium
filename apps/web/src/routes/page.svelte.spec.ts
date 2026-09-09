import { page } from '@vitest/browser/context';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Page from './+page.svelte';

// The load function returns `{ owner, repo, results }` where `results` is a
// promise resolving to the GitHub search response. Mirror that shape here so the
// component's `await data.results` has something to work with.
const data = {
  owner: 'sungmanito',
  repo: 'mono',
  results: Promise.resolve({ data: { items: [] } }),
};

describe('/+page.svelte', () => {
  it('should render the heading', async () => {
    render(Page, { data });

    const heading = page.getByRole('heading', { level: 5 });
    await expect.element(heading).toBeInTheDocument();
  });
});
