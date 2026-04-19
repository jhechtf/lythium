import type { StackDiffResponse } from '@lythium/api/types';
import { error } from '@sveltejs/kit';
import { API_URL } from '$env/static/private';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, cookies }) => {
  const token = cookies.get('token');
  if (!token) throw error(401, 'Not authenticated');

  const { owner, repo, number } = params;

  const res = await fetch(
    `${API_URL}/repos/${owner}/${repo}/pr/${number}/diff`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) throw error(401, body.error ?? 'Unauthorized');
    if (res.status === 404) throw error(404, body.error ?? 'PR not found');
    if (res.status === 429)
      throw error(429, 'GitHub rate limit hit — try again later');
    throw error(502, 'Failed to load diff data');
  }

  const data: StackDiffResponse = await res.json();

  return {
    owner,
    repo,
    number: parseInt(number, 10),
    stack: data.stack,
  };
};
