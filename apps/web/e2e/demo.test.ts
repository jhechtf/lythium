import { expect, test } from '@playwright/test';

test('signed-out visitors are sent to GitHub sign in, returning to the inbox', async ({
  page,
}) => {
  const res = await page.request.get('/?status=open', { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers().location).toBe(
    '/auth/github/login?redirectTo=%2F%3Fstatus%3Dopen',
  );
});
