import { cancel, isCancel, select } from '@clack/prompts';
import { program } from 'commander';
import pc from 'picocolors';
import { currentBranch, checkout as gitCheckout } from '../git.ts';
import { LyError, type LyStore, load } from '../store.ts';

program
  .command('checkout')
  .alias('co')
  .description('Switch to a tracked branch (interactive if no branch given)')
  .argument('[branch]', 'branch to switch to')
  .action(async (branchArg: string | undefined) => {
    let store: LyStore;
    try {
      store = load();
    } catch (e) {
      console.error(pc.red(e instanceof LyError ? e.message : String(e)));
      process.exit(1);
    }

    const current = currentBranch();
    const tracked = [store.trunk, ...Object.keys(store.branches)].filter(
      (b) => b !== current,
    );

    if (branchArg) {
      if (branchArg !== store.trunk && !store.branches[branchArg]) {
        console.error(
          pc.red(`Branch ${pc.bold(branchArg)} is not tracked by Lythium.`),
        );
        process.exit(1);
      }
      gitCheckout(branchArg);
      console.log(pc.green(`Switched to ${pc.bold(branchArg)}`));
      return;
    }

    if (tracked.length === 0) {
      console.log(pc.yellow('No other tracked branches to switch to.'));
      return;
    }

    const choice = await select({
      message: 'Switch to branch:',
      options: tracked.map((b) => {
        const meta = store.branches[b];
        const hint = meta
          ? `parent: ${meta.parent}${meta.prNumber ? ` · PR #${meta.prNumber}` : ''}`
          : 'trunk';
        return { value: b, label: b, hint };
      }),
    });

    if (isCancel(choice)) {
      cancel();
      process.exit(0);
    }

    gitCheckout(choice as string);
    console.log(pc.green(`Switched to ${pc.bold(choice as string)}`));
  });
