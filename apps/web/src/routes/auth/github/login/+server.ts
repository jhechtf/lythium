import { redirect } from '@sveltejs/kit';
import { dev } from '$app/env';
import { GITHUB_APP_CLIENT_ID } from '$app/env/private';
import {
  buildAuthorizeUrl,
  cookieOptions,
  createState,
  LOGIN_TTL_SECONDS,
  RETURN_COOKIE,
  STATE_COOKIE,
  safeRedirectPath,
} from '#lib/server/oauth.ts';

export const GET = ({ url, cookies }) => {
  const state = createState();
  const options = { ...cookieOptions(!dev), maxAge: LOGIN_TTL_SECONDS };

  cookies.set(STATE_COOKIE, state, options);
  cookies.set(
    RETURN_COOKIE,
    safeRedirectPath(url.searchParams.get('redirectTo')),
    options,
  );

  redirect(302, buildAuthorizeUrl(GITHUB_APP_CLIENT_ID, state));
};
