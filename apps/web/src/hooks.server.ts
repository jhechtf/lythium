import { Octokit } from 'octokit';

export const handle = async ({ event, resolve }) => {
  const token = event.cookies.get('token');

  const octokit = new Octokit({
    auth: token,
  });

  event.locals.octokit = octokit;

  return resolve(event);
};
