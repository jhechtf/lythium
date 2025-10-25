import { redirect } from '@sveltejs/kit';

export const load = async ({ request }) => {
  console.info('hi');
  return redirect(301, '/');
};