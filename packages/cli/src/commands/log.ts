import { program } from 'commander';
import pc from 'picocolors';
import { currentBranch } from '../git.ts';
import { renderShortStack, renderTree } from '../stack.ts';
import { LyError, type LyStore, load } from '../store.ts';

program
  .command('log', { isDefault: true })
  .description('Show the stack tree')
  .option('-s, --short', 'show only the current stack lineage')
  .action((opts: { short?: boolean }) => {
    let store: LyStore;
    try {
      store = load();
    } catch (e) {
      console.error(pc.red(e instanceof LyError ? e.message : String(e)));
      process.exit(1);
    }

    const branch = currentBranch();

    if (opts.short) {
      if (!store.branches[branch] && branch !== store.trunk) {
        console.error(
          pc.red(
            `Branch ${pc.bold(branch)} is not tracked. Run \`ly track\` to add it.`,
          ),
        );
        process.exit(1);
      }
      console.log(renderShortStack(store, branch));
    } else {
      console.log(renderTree(store, branch));
    }
  });
