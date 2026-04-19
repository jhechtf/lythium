import { outro } from '@clack/prompts';
import { program } from 'commander';
import pc from 'picocolors';
import { currentBranch } from '../git.ts';
import { getChildren } from '../stack.ts';
import { LyError, type LyStore, load, save } from '../store.ts';

program
  .command('untrack')
  .description('Stop tracking a branch in the stack')
  .argument('[branch]', 'branch to untrack (default: current)')
  .action((branchArg: string | undefined) => {
    let store: LyStore;
    try {
      store = load();
    } catch (e) {
      console.error(pc.red(e instanceof LyError ? e.message : String(e)));
      process.exit(1);
    }

    const branch = branchArg ?? currentBranch();

    if (branch === store.trunk) {
      console.error(
        pc.red(`Cannot untrack trunk branch (${pc.bold(store.trunk)}).`),
      );
      process.exit(1);
    }

    if (!store.branches[branch]) {
      console.error(
        pc.red(`Branch ${pc.bold(branch)} is not tracked by Lythium.`),
      );
      process.exit(1);
    }

    const children = getChildren(store, branch);
    if (children.length > 0) {
      console.log(
        pc.yellow(
          `Warning: ${pc.bold(branch)} has ${children.length} child branch(es) that will lose their parent reference: `,
        ) + children.map(pc.bold).join(', '),
      );
    }

    delete store.branches[branch];
    save(store);

    outro(pc.green(`Untracked ${pc.bold(branch)}`));
  });
