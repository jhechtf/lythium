import { outro } from '@clack/prompts';
import { program } from 'commander';
import pc from 'picocolors';
import {
  amendCommit,
  checkout,
  currentBranch,
  forceRebase,
  hasStagedChanges,
  stageAll,
} from '../git.ts';
import { getAllDescendants } from '../stack.ts';
import { LyError, load, save } from '../store.ts';

program
  .command('modify')
  .description('Amend the current branch and automatically restack children')
  .option('-a, --all', 'stage all working changes')
  .option('-m, --message <msg>', 'new commit message (omit to keep current)')
  .action(async (opts: { all?: boolean; message?: string }) => {
    try {
      const store = load();

      const branch = currentBranch();

      if (branch === store.trunk) {
        console.error(
          pc.red('Cannot modify trunk. Create a new branch with `ly create`.'),
        );
        process.exit(1);
      }

      if (!store.branches[branch]) {
        console.error(
          pc.red(
            `Branch ${pc.bold(branch)} is not tracked. Run \`ly track\` to add it.`,
          ),
        );
        process.exit(1);
      }

      if (opts.all) stageAll();

      if (!hasStagedChanges() && !opts.message) {
        console.error(
          pc.red('Nothing staged and no --message given. Nothing to amend.'),
        );
        process.exit(1);
      }

      amendCommit(opts.message);

      const descendants = getAllDescendants(store, branch);
      if (descendants.length > 0) {
        console.log(pc.dim(`Restacking ${descendants.length} branch(es)...`));
        for (const child of descendants) {
          const parent = store.branches[child].parent;
          console.log(pc.dim(`  ${child} → ${parent}`));
          forceRebase(child, parent, branch);
        }
        checkout(branch);
      }

      save(store);
      outro(
        pc.green(`Modified ${pc.bold(branch)}`) +
          (descendants.length > 0
            ? pc.dim(` · restacked ${descendants.length} branch(es)`)
            : ''),
      );
    } catch (e) {
      console.error(pc.red(e instanceof LyError ? e.message : String(e)));
      process.exit(1);
    }
  });
