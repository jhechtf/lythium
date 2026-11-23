import { defineEnvVars } from '@sveltejs/kit/env';

/** A required, non-empty string. */
const required = (name: string) => (value: string | undefined) => {
  if (!value) throw new Error(`${name} must be set`);
  return value;
};

// Read at build time and inlined, like `$env/static/private` was. They are
// server-only: import them from `$app/env/private`.
export const variables = defineEnvVars({
  GITHUB_APP_CLIENT_ID: {
    static: true,
    schema: required('GITHUB_APP_CLIENT_ID'),
    description: 'Client ID of the Lythium GitHub App (OAuth login).',
  },
  GITHUB_APP_CLIENT_SECRET: {
    static: true,
    schema: required('GITHUB_APP_CLIENT_SECRET'),
    description: 'Client secret of the Lythium GitHub App.',
  },
  API_URL: {
    static: true,
    schema: required('API_URL'),
    description: 'Base URL of the Lythium API (apps/api), no trailing slash.',
  },
});
