# TypeScript 5 → 7 type-check benchmark

- Host: `win32` Node v24.4.1
- Runs per package: 11 (median reported), 1 warm-up discarded
- Command: `tsc --noEmit -p tsconfig.json` per package
- TypeScript 5: `5.9.3` (JS) · TypeScript 7: `7.0.2` (native)

| Package | TS 5 median | TS 7 median | Speed-up |
| --- | ---: | ---: | ---: |
| @lythium/api | 914 ms | 137 ms | 6.65× |
| @lythium/github-app | 2227 ms | 308 ms | 7.23× |
| @lythium/cli | 1266 ms | 178 ms | 7.12× |
| @lythium/db | 1388 ms | 250 ms | 5.54× |
| **Total (serial)** | **5795 ms** | **874 ms** | **6.63×** |

> Bundle `build` times are unchanged: `tsdown` transpiles with oxc and `vite`
> with esbuild/rolldown — neither invokes `tsc` — so the migration only moves
> the type-check step, which nothing in CI ran before.
