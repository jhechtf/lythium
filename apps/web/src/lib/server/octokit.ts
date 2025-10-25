import { App, OAuthApp } from 'octokit';
import { GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET } from '$env/static/private';

export const app = new OAuthApp({
  clientId: GITHUB_APP_CLIENT_ID,
  clientSecret: GITHUB_APP_CLIENT_SECRET,
  defaultScopes:  ['repo']
});
