import posthog from 'posthog-js'
import { browser } from '$app/environment';

export const load = async () => {
  if (browser) {
    posthog.init(
      'phc_HaLqMjTX6V0XcDNz0w1fpHvdXDg2y0I7BdhkKLsE6Ai',
      {
        api_host: 'https://us.i.posthog.com',
        defaults: '2026-05-30'
      }
    )
  }

  return
};