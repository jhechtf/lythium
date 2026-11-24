import { randomBytes, timingSafeEqual } from 'node:crypto';

export const STATE_COOKIE = 'oauth_state';
export const RETURN_COOKIE = 'oauth_return';
export const TOKEN_COOKIE = 'token';
export const COOKIE_PATH = '/';
/** How long a login attempt may take, in seconds. */
export const LOGIN_TTL_SECONDS = 10 * 60;

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';

export function createState(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Only same-origin relative paths are allowed as a post-login destination.
 * Anything else (absolute URLs, `//host`, `/\host`, control chars) becomes `/`.
 */
export function safeRedirectPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars is the point
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return '/';
  return value;
}

export function buildAuthorizeUrl(clientId: string, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('state', state);
  return url.toString();
}

export function statesMatch(
  expected: string | undefined,
  actual: string | null,
): boolean {
  if (!expected || !actual) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function cookieOptions(secure: boolean) {
  return {
    path: COOKIE_PATH,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
  };
}

export type LoginResult =
  | { ok: true; token: string; expiresIn?: number }
  | { ok: false; status: number; message: string };

interface CompleteLoginInput {
  params: URLSearchParams;
  stateCookie: string | undefined;
  clientId: string;
  clientSecret: string;
  fetch: typeof fetch;
}

const GITHUB_UNAVAILABLE: LoginResult = {
  ok: false,
  status: 502,
  message: 'GitHub is unavailable right now. Please try signing in again.',
};

/**
 * Validates the OAuth callback and exchanges the code for a token.
 * Never includes the client secret or token in an error message.
 */
export async function completeLogin(
  input: CompleteLoginInput,
): Promise<LoginResult> {
  const { params, stateCookie, clientId, clientSecret } = input;

  if (!statesMatch(stateCookie, params.get('state'))) {
    return {
      ok: false,
      status: 400,
      message:
        'Your sign-in attempt could not be verified. Please start again.',
    };
  }

  if (params.get('error')) {
    return {
      ok: false,
      status: 403,
      message:
        params.get('error') === 'access_denied'
          ? 'You denied access to GitHub, so we could not sign you in.'
          : 'GitHub refused the sign-in request. Please try again.',
    };
  }

  const code = params.get('code');
  if (!code) {
    return {
      ok: false,
      status: 400,
      message: 'GitHub did not send a sign-in code. Please try again.',
    };
  }

  try {
    const res = await input.fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });
    if (!res.ok) return GITHUB_UNAVAILABLE;

    // GitHub reports a bad/expired code as HTTP 200 with an `error` field.
    const body = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!body.access_token) {
      return {
        ok: false,
        status: 400,
        message:
          'That sign-in code is invalid or has expired. Please start again.',
      };
    }

    const userRes = await input.fetch(USER_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${body.access_token}`,
      },
    });
    if (userRes.status === 401 || userRes.status === 403) {
      return {
        ok: false,
        status: 401,
        message: 'GitHub did not accept the new token. Please try again.',
      };
    }
    if (!userRes.ok) return GITHUB_UNAVAILABLE;

    return {
      ok: true,
      token: body.access_token,
      expiresIn: body.expires_in,
    };
  } catch {
    return GITHUB_UNAVAILABLE;
  }
}
