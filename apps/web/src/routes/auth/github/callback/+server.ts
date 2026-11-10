import { error, redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import {
  GITHUB_APP_CLIENT_ID,
  GITHUB_APP_CLIENT_SECRET,
} from '$env/static/private';
import {
  COOKIE_PATH,
  completeLogin,
  cookieOptions,
  RETURN_COOKIE,
  STATE_COOKIE,
  safeRedirectPath,
  TOKEN_COOKIE,
} from '$lib/server/oauth';

export const GET = async ({ url, cookies, fetch }) => {
  const stateCookie = cookies.get(STATE_COOKIE);
  const returnTo = safeRedirectPath(cookies.get(RETURN_COOKIE));

  // State and return cookies are single-use.
  cookies.delete(STATE_COOKIE, { path: COOKIE_PATH });
  cookies.delete(RETURN_COOKIE, { path: COOKIE_PATH });

  const result = await completeLogin({
    params: url.searchParams,
    stateCookie,
    clientId: GITHUB_APP_CLIENT_ID,
    clientSecret: GITHUB_APP_CLIENT_SECRET,
    fetch,
  });

  if (!result.ok) error(result.status, result.message);

  cookies.set(TOKEN_COOKIE, result.token, {
    ...cookieOptions(!dev),
    ...(result.expiresIn ? { maxAge: result.expiresIn } : {}),
  });

  redirect(303, returnTo);
};
