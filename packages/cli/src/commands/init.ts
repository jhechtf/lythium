import { program } from 'commander';
import { intro, outro, text, confirm, isCancel, cancel } from '@clack/prompts';
import pc from 'picocolors';
import { isGitRepo, listLocalBranches } from '../git.ts';
import { isInitialized, init } from '../store.ts';

program
  .command('init')
  .description('Initialize Lythium in this git repository')
  .option('--trunk <branch>', 'trunk branch name (default: auto-detect)')
  .action(async (opts: { trunk?: string }) => {
    intro(pc.bold('ly init'));

    if (!isGitRepo()) {
      cancel('Not a git repository. Run this inside a git repo.');
      process.exit(1);
    }

    if (isInitialized()) {
      cancel('Lythium is already initialized in this repo.');
      process.exit(1);
    }

    let trunk = opts.trunk;

    if (!trunk) {
      const branches = listLocalBranches();
      if (branches.includes('main')) {
        trunk = 'main';
      } else if (branches.includes('master')) {
        trunk = 'master';
      }
    }

    if (!trunk) {
      const input = await text({
        message: 'Trunk branch name:',
        placeholder: 'main',
        validate: (v) => (v.trim() ? undefined : 'Branch name is required'),
      });
      if (isCancel(input)) {
        cancel();
        process.exit(0);
      }
      trunk = (input as string).trim();
    } else {
      const ok = await confirm({
        message: `Use ${pc.bold(trunk)} as trunk branch?`,
      });
      if (isCancel(ok) || !ok) {
        const input = await text({
          message: 'Trunk branch name:',
          validate: (v) => (v.trim() ? undefined : 'Branch name is required'),
        });
        if (isCancel(input)) {
          cancel();
          process.exit(0);
        }
        trunk = (input as string).trim();
      }
    }

    init(trunk);
    outro(pc.green(`Initialized! Trunk branch: ${pc.bold(trunk)}`));
  });
