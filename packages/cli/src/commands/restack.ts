import { program } from 'commander';
import { outro } from '@clack/prompts';
import pc from 'picocolors';
import { currentBranch, forceRebase, checkout } from '../git.ts';
import { load, save, LyError } from '../store.ts';
import { getAllDescendants } from '../stack.ts';

program
  .command('restack')
  .description('Rebase branches onto their parents to fix stack alignment')
  .option('--all', 'restack every tracked branch (not just current stack)')
  .action((opts: { all?: boolean }) => {
    let store;
    try {
      store = load();
    } catch (e) {
      console.error(pc.red(e instanceof LyError ? e.message : String(e)));
      process.exit(1);
    }

    const branch = currentBranch();
    const origin = branch;

    let toRestack: string[];

    if (opts.all) {
      // BFS from trunk over all tracked branches
      toRestack = getAllDescendants(store, store.trunk);
    } else {
      if (branch === store.trunk) {
        // On trunk — restack everything
        toRestack = getAllDescendants(store, store.trunk);
      } else if (!store.branches[branch]) {
        console.error(pc.red(`Branch ${pc.bold(branch)} is not tracked. Run \`ly track\` to add it.`));
        process.exit(1);
      } else {
        // Only restack descendants of current branch
        toRestack = getAllDescendants(store, branch);
      }
    }

    if (toRestack.length === 0) {
      console.log(pc.yellow('Nothing to restack.'));
      return;
    }

    console.log(pc.dim(`Restacking ${toRestack.length} branch(es)...`));
    for (const b of toRestack) {
      const parent = store.branches[b].parent;
      console.log(pc.dim(`  ${b} → rebased on ${parent}`));
      forceRebase(b, parent, origin);
    }

    checkout(origin);
    save(store);
    outro(pc.green(`Restacked ${toRestack.length} branch(es)`));
  });
