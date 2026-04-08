import { program } from 'commander';
import { outro, multiselect, isCancel, cancel } from '@clack/prompts';
import pc from 'picocolors';
import { fetch, currentBranch, isMergedInto, deleteBranch, forceRebase, checkout } from '../git.ts';
import { load, save, LyError } from '../store.ts';
import { getAllDescendants } from '../stack.ts';

program
  .command('sync')
  .description('Fetch from origin, clean up merged branches, and restack')
  .action(async () => {
    let store;
    try {
      store = load();
    } catch (e) {
      console.error(pc.red(e instanceof LyError ? e.message : String(e)));
      process.exit(1);
    }

    // 1. Fetch
    process.stdout.write(pc.dim('Fetching from origin... '));
    try {
      fetch();
      process.stdout.write(pc.green('✓\n'));
    } catch (e: any) {
      process.stdout.write(pc.red('✗\n'));
      console.error(pc.red(`Fetch failed: ${e.message}`));
      process.exit(1);
    }

    // 2. Detect merged branches
    const trackedBranches = Object.keys(store.branches);
    const merged = trackedBranches.filter((b) => {
      try {
        return isMergedInto(b, `origin/${store.trunk}`);
      } catch {
        return false;
      }
    });

    const origin = currentBranch();

    if (merged.length > 0) {
      console.log(pc.dim(`\nFound ${merged.length} merged branch(es):`));
      merged.forEach((b) => console.log(pc.dim(`  ${b}`)));

      const toDelete = await multiselect({
        message: 'Select branches to delete:',
        options: merged.map((b) => ({
          value: b,
          label: b,
          hint: `merged into ${store.trunk}`,
        })),
        required: false,
      });

      if (!isCancel(toDelete)) {
        for (const b of toDelete as string[]) {
          // Move children of deleted branch up to its parent
          const meta = store.branches[b];
          const children = Object.entries(store.branches).filter(([, m]) => m.parent === b);
          for (const [child, childMeta] of children) {
            childMeta.parent = meta.parent;
            console.log(pc.dim(`  Reparenting ${child} → ${meta.parent}`));
          }

          // Delete branch (switch away first if needed)
          if (currentBranch() === b) {
            checkout(meta.parent);
          }
          try {
            deleteBranch(b, true);
          } catch {
            // May already be gone remotely, ignore
          }
          delete store.branches[b];
          console.log(pc.green(`  Deleted ${b}`));
        }
      }
    } else {
      console.log(pc.dim('No merged branches found.'));
    }

    // 3. Restack remaining branches
    const toRestack = getAllDescendants(store, store.trunk);
    if (toRestack.length > 0) {
      console.log(pc.dim(`\nRestacking ${toRestack.length} branch(es)...`));
      for (const b of toRestack) {
        const parent = store.branches[b].parent;
        console.log(pc.dim(`  ${b} → ${parent}`));
        forceRebase(b, parent, origin);
      }
      checkout(origin);
    }

    save(store);
    outro(pc.green('Sync complete'));
  });
