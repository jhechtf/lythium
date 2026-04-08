#!/usr/bin/env node
import { program } from 'commander';
import packageJson from '#package.json' with { type: 'json' };
import { setDebug } from './git.ts';

// Register all commands
import './auth.ts';
import './commands/init.ts';
import './commands/create.ts';
import './commands/log.ts';
import './commands/checkout.ts';
import './commands/up.ts';
import './commands/modify.ts';
import './commands/restack.ts';
import './commands/track.ts';
import './commands/untrack.ts';
import './commands/submit.ts';
import './commands/sync.ts';

program
  .name('ly')
  .description('Open-source, git-compatible stacked diff workflow CLI')
  .version(packageJson.version)
  .option('--debug', 'print underlying git commands to stderr')
  .showHelpAfterError()
  .hook('preAction', () => {
    const opts = program.opts<{ debug?: boolean }>();
    if (opts.debug) setDebug(true);
  });

program.parse(process.argv);
