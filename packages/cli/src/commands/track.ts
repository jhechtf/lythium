import { program } from 'commander';
import { outro, select, isCancel, cancel } from '@clack/prompts';
import pc from 'picocolors';
import { currentBranch, listLocalBranches } from '../git.ts';
import { load, save, LyError } from '../store.ts';

program
  .command('track')
  .description('Start tracking an existing branch in the stack')
  .argument('[branch]', 'branch to track (default: current)')
  .action(async (branchArg: string | undefined) => {
    let store;
    try {
      store = load();
    } catch (e) {
      console.error(pc.red(e instanceof LyError ? e.message : String(e)));
      process.exit(1);
    }

    const branch = branchArg ?? currentBranch();

    if (branch === store.trunk) {
      console.error(pc.red(`Cannot track trunk branch (${store.trunk}).`));
      process.exit(1);
    }

    if (store.branches[branch]) {
      console.log(pc.yellow(`${pc.bold(branch)} is already tracked (parent: ${store.branches[branch].parent}).`));
      return;
    }

    // Options for parent: trunk + all tracked branches except the branch itself
    const parentOptions = [store.trunk, ...Object.keys(store.branches)].filter(
      (b) => b !== branch
    );

    const choice = await select({
      message: `Parent branch for ${pc.bold(branch)}:`,
      options: parentOptions.map((b) => ({
        value: b,
        label: b,
        hint: b === store.trunk ? 'trunk' : undefined,
      })),
    });

    if (isCancel(choice)) { cancel(); process.exit(0); }

    const parent = choice as string;
    store.branches[branch] = { parent };
    save(store);

    outro(pc.green(`Tracking ${pc.bold(branch)}`) + pc.dim(` (parent: ${parent})`));
  });
