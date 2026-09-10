#!/usr/bin/env node
// Benchmark: TypeScript 5 (`tsc`, JS) vs TypeScript 7 (`tsc`, native) type-check times.
//
// Runs `tsc --noEmit` for every workspace package that has a `typecheck` script,
// once per compiler version, `RUNS` times each (plus one discarded warm-up), and
// prints a Markdown comparison table.
//
// Usage:  node scripts/bench-typecheck.mjs [--runs 7] [--json out.json]

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const RUNS = Number(readFlag('--runs') ?? 7);
const JSON_OUT = readFlag('--json');

function readFlag(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

// Compiler versions to compare, resolved straight out of the pnpm store so we
// never have to mutate package.json to switch between them. `apps/web` still
// depends on TypeScript 5, which is why both majors are present after install.
const pnpmStore = join(repoRoot, 'node_modules/.pnpm');

function resolveTsc(majorPrefix, label) {
  const dir = readdirSync(pnpmStore)
    .filter((d) => d.startsWith(`typescript@${majorPrefix}`))
    .sort()
    .pop();
  const tsc = dir && join(pnpmStore, dir, 'node_modules/typescript/bin/tsc');
  if (!tsc || !existsSync(tsc)) {
    throw new Error(
      `No TypeScript ${majorPrefix}x found in ${pnpmStore} — run pnpm install first`,
    );
  }
  const version = JSON.parse(
    readFileSync(
      join(pnpmStore, dir, 'node_modules/typescript/package.json'),
      'utf8',
    ),
  ).version;
  return { label, version, tsc };
}

const COMPILERS = [
  resolveTsc('5.', 'TypeScript 5'),
  resolveTsc('7.', 'TypeScript 7'),
];

// Workspace packages that opt into type-checking.
const PACKAGES = [
  { name: '@lythium/api', dir: 'apps/api' },
  { name: '@lythium/github-app', dir: 'apps/github-app' },
  { name: '@lythium/cli', dir: 'packages/cli' },
  { name: '@lythium/db', dir: 'packages/db' },
].filter((p) => {
  const pkg = JSON.parse(
    readFileSync(join(repoRoot, p.dir, 'package.json'), 'utf8'),
  );
  return Boolean(pkg.scripts?.typecheck);
});

function timeOnce(tsc, dir) {
  const cwd = join(repoRoot, dir);
  const start = performance.now();
  let ok = true;
  try {
    execFileSync(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json'], {
      cwd,
      stdio: 'pipe',
    });
  } catch {
    ok = false; // pre-existing type errors: still a valid timing sample
  }
  return { ms: performance.now() - start, ok };
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    min: s[0],
    max: s[s.length - 1],
    mean: sum / s.length,
    median: s[Math.floor(s.length / 2)],
  };
};

console.log(
  `Benchmarking ${PACKAGES.length} packages, ${RUNS} runs each (after 1 warm-up).\n`,
);

const results = [];
for (const pkg of PACKAGES) {
  const row = { package: pkg.name };
  for (const comp of COMPILERS) {
    timeOnce(comp.tsc, pkg.dir); // warm-up (fs cache, etc.)
    const samples = [];
    let ok = true;
    for (let i = 0; i < RUNS; i++) {
      const r = timeOnce(comp.tsc, pkg.dir);
      samples.push(r.ms);
      ok = ok && r.ok;
    }
    row[comp.version] = { ...stats(samples), ok, samples };
    process.stdout.write(
      `  ${pkg.name.padEnd(22)} ${comp.label}: ${row[comp.version].median.toFixed(0)} ms (median)${ok ? '' : '  [type errors]'}\n`,
    );
  }
  results.push(row);
}

const v5 = COMPILERS[0].version;
const v7 = COMPILERS[1].version;

let md = '';
md += `# TypeScript 5 → 7 type-check benchmark\n\n`;
md += `- Host: \`${process.platform}\` Node ${process.version}\n`;
md += `- Runs per package: ${RUNS} (median reported), 1 warm-up discarded\n`;
md += `- Command: \`tsc --noEmit -p tsconfig.json\` per package\n`;
md += `- TypeScript 5: \`${v5}\` (JS) · TypeScript 7: \`${v7}\` (native)\n\n`;
md += `| Package | TS 5 median | TS 7 median | Speed-up |\n`;
md += `| --- | ---: | ---: | ---: |\n`;

let sum5 = 0;
let sum7 = 0;
for (const r of results) {
  const a = r[v5].median;
  const b = r[v7].median;
  sum5 += a;
  sum7 += b;
  md += `| ${r.package} | ${a.toFixed(0)} ms | ${b.toFixed(0)} ms | ${(a / b).toFixed(2)}× |\n`;
}
md += `| **Total (serial)** | **${sum5.toFixed(0)} ms** | **${sum7.toFixed(0)} ms** | **${(sum5 / sum7).toFixed(2)}×** |\n`;
md += `\n`;
md += `> Bundle \`build\` times are unchanged: \`tsdown\` transpiles with oxc and \`vite\`\n`;
md += `> with esbuild/rolldown — neither invokes \`tsc\` — so the migration only moves\n`;
md += `> the type-check step, which nothing in CI ran before.\n`;

console.log(`\n${md}`);

if (JSON_OUT) {
  writeFileSync(
    resolve(JSON_OUT),
    JSON.stringify(
      {
        meta: {
          runs: RUNS,
          node: process.version,
          platform: process.platform,
          compilers: COMPILERS.map(({ tsc, ...c }) => c),
        },
        results,
      },
      null,
      2,
    ),
  );
  console.log(`Wrote ${JSON_OUT}`);
}

writeFileSync(join(repoRoot, 'scripts/bench-typecheck.results.md'), md);
console.log('Wrote scripts/bench-typecheck.results.md');
