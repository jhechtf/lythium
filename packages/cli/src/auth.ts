import { cancel, intro, isCancel, outro, password } from '@clack/prompts';
import { program } from 'commander';
import pc from 'picocolors';
import { fetch } from 'undici';
import { deleteToken, getToken, setToken } from './credentials.ts';

export const auth = program
  .command('auth')
  .description('Manage authentication for publishing PRs to GitHub');

auth
  .command('login', { isDefault: true })
  .description('Log in with a GitHub Personal Access Token')
  .action(async () => {
    intro(pc.bold('ly auth login'));

    console.log(
      pc.dim(
        'Create a token at: https://github.com/settings/tokens\n' +
          'Required scopes: repo, read:user',
      ),
    );

    const token = await password({ message: 'GitHub Personal Access Token:' });
    if (isCancel(token)) {
      cancel();
      process.exit(0);
    }

    const tokenStr = token as string;

    // Validate token
    process.stdout.write(pc.dim('Validating token... '));
    let username: string;
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${tokenStr}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'lythium-cli',
        },
      });

      if (!res.ok) {
        process.stdout.write(pc.red('✗\n'));
        cancel(
          `Invalid token (HTTP ${res.status}). Check that it has the required scopes.`,
        );
        process.exit(1);
      }

      const user = (await res.json()) as { login: string };
      username = user.login;
      process.stdout.write(pc.green('✓\n'));
    } catch (e) {
      process.stdout.write(pc.red('✗\n'));
      cancel(`Network error: ${(e as Error).message}`);
      process.exit(1);
    }

    setToken(tokenStr);
    outro(pc.green(`Logged in as ${pc.bold(`@${username}`)}`));
  });

auth
  .command('logout')
  .description('Remove stored GitHub credentials')
  .action(async () => {
    const deleted = deleteToken();
    if (deleted) {
      console.log(pc.green('Logged out.'));
    } else {
      console.log(pc.yellow('No stored credentials found.'));
    }
  });

auth
  .command('status')
  .description('Show current login status')
  .action(async () => {
    const token = getToken();
    if (!token) {
      console.log(pc.yellow('Not logged in. Run `ly auth login`.'));
      return;
    }

    try {
      const res = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'lythium-cli',
        },
      });
      if (!res.ok) {
        console.log(
          pc.red(
            `Token stored but invalid (HTTP ${res.status}). Run \`ly auth login\` again.`,
          ),
        );
        return;
      }
      const user = (await res.json()) as { login: string };
      console.log(pc.green(`Logged in as ${pc.bold(`@${user.login}`)}`));
    } catch {
      console.log(pc.yellow('Token stored but could not reach GitHub.'));
    }
  });

auth
  .command('switch <profile>')
  .description('Switch profiles (reserved for multi-account support)')
  .action(() => {
    console.log(pc.yellow('Multi-profile support is not yet implemented.'));
  });
