import { redirect } from '@sveltejs/kit';

export const load = async ({ cookies, locals }) => {
  const user = await locals.octokit.rest.users
    .getAuthenticated()
    .then((r) => r.data);
  if (!user) return redirect(401, '/');

  const results = locals.octokit.rest.search.issuesAndPullRequests({
    q: `involves:${user.login} type:pr state:open`,
    per_page: 5,
  });
  // const results = locals.octokit.rest.pulls.list({
  //   owner: 'sungmanito',
  //   repo: 'mono',
  //   query: 'is:pr is:open',
  // });
  results.then((r) => console.info(r.data));

  return {
    owner: 'sungmanito',
    repo: 'mono',
    results,
  };
};
