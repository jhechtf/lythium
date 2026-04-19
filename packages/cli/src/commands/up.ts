import { cancel, isCancel, select } from '@clack/prompts';
import { program } from 'commander';
import pc from 'picocolors';
import { checkout, currentBranch } from '../git.ts';
import { getChildren } from '../stack.ts';
import { LyError, type LyStore, load } from '../store.ts';

program
  .command('up')
  .description('Move up the stack to a child branch')
  .action(async () => {
    let store: LyStore;
    try {
      store = load();
    } catch (e) {
      console.error(pc.red(e instanceof LyError ? e.message : String(e)));
      process.exit(1);
    }

    const branch = currentBranch();
    const children = getChildren(store, branch);

    if (children.length === 0) {
      console.log(
        pc.yellow(
          `${pc.bold(branch)} has no child branches — already at the top.`,
        ),
      );
      return;
    }

    let target: string;
    if (children.length === 1) {
      target = children[0];
    } else {
      const choice = await select({
        message: 'Multiple children — choose one:',
        options: children.map((c) => ({ value: c, label: c })),
      });
      if (isCancel(choice)) {
        cancel();
        process.exit(0);
      }
      target = choice as string;
    }

    checkout(target);
    console.log(pc.green(`Moved up to ${pc.bold(target)}`));
  });

program
  .command('down')
  .description('Move down the stack to the parent branch')
  .action(() => {
    let store: LyStore;
    try {
      store = load();
    } catch (e) {
      console.error(pc.red(e instanceof LyError ? e.message : String(e)));
      process.exit(1);
    }

    const branch = currentBranch();

    if (branch === store.trunk) {
      console.log(pc.yellow(`Already on trunk (${pc.bold(store.trunk)}).`));
      return;
    }

    const meta = store.branches[branch];
    if (!meta) {
      console.error(
        pc.red(
          `Branch ${pc.bold(branch)} is not tracked. Run \`ly track\` to add it.`,
        ),
      );
      process.exit(1);
    }

    checkout(meta.parent);
    console.log(pc.green(`Moved down to ${pc.bold(meta.parent)}`));
  });
