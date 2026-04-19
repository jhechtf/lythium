import { program } from 'commander';
import { intro, outro, text, isCancel, cancel } from '@clack/prompts';
import pc from 'picocolors';
import {
  currentBranch,
  createBranch,
  stageAll,
  hasStagedChanges,
  commit,
  commitEmpty,
} from '../git.ts';
import { load, save, LyError } from '../store.ts';

program
  .command('create')
  .description('Create a new stacked branch on top of the current branch')
  .argument('[branch]', 'new branch name')
  .option('-a, --all', 'stage all working changes before creating')
  .option('-m, --message <msg>', 'commit message')
  .action(
    async (
      branchArg: string | undefined,
      opts: { all?: boolean; message?: string },
    ) => {
      intro(pc.bold('ly create'));

      let store;
      try {
        store = load();
      } catch (e) {
        cancel(e instanceof LyError ? e.message : String(e));
        process.exit(1);
      }

      if (opts.all) stageAll();

      const hasStagedNow = hasStagedChanges();

      if (!hasStagedNow && !branchArg && !opts.message) {
        cancel(
          'Nothing staged. Stage changes or use -a to stage all working changes.',
        );
        process.exit(1);
      }

      const parent = currentBranch();

      let branchName = branchArg;
      if (!branchName) {
        const input = await text({
          message: 'New branch name:',
          placeholder: 'feat/my-change',
          validate: (v) => (v.trim() ? undefined : 'Branch name is required'),
        });
        if (isCancel(input)) {
          cancel();
          process.exit(0);
        }
        branchName = (input as string).trim();
      }

      if (store.branches[branchName]) {
        cancel(`Branch ${pc.bold(branchName)} is already tracked by Lythium.`);
        process.exit(1);
      }

      const isEmpty = !hasStagedNow;

      let message = opts.message;
      if (!message) {
        if (isEmpty) {
          // Default to the branch name so the user doesn't have to type anything
          message = branchName;
        } else {
          const input = await text({
            message: 'Commit message:',
            placeholder: `feat: ${branchName}`,
            validate: (v) =>
              v.trim() ? undefined : 'Commit message is required',
          });
          if (isCancel(input)) {
            cancel();
            process.exit(0);
          }
          message = (input as string).trim();
        }
      }

      createBranch(branchName, parent);
      if (isEmpty) {
        commitEmpty(message);
      } else {
        commit(message);
      }

      store.branches[branchName] = { parent };
      save(store);

      outro(
        pc.green(`Created ${pc.bold(branchName)}`) +
          pc.dim(` stacked on ${parent}`),
      );
    },
  );
