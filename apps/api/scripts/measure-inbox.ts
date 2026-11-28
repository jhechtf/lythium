/**
 * Dev-only: run the inbox's exact GraphQL request against real GitHub and print
 * its rate-limit cost. Not part of the service or the build.
 *
 *   GITHUB_TOKEN=<your token> pnpm --filter @lythium/api measure:inbox [q]
 *
 * Prints query acceptance/errors, the viewer login, sizes, `rateLimit` and the
 * latency. Never prints the token, titles, repository names or raw responses.
 * Each run spends `cost` points of your hourly budget.
 */
import { inboxRequest } from '../inbox.ts';

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('Set GITHUB_TOKEN to a token you are allowed to use.');
  process.exit(2);
}

const q = process.argv.slice(2).join(' ');
const { query, variables } = inboxRequest(q);
const started = performance.now();
const res = await fetch('https://api.github.com/graphql', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'user-agent': 'lythium-inbox-measure',
  },
  body: JSON.stringify({ query, variables }),
});
const latencyMs = Math.round(performance.now() - started);
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  typeof v === 'object' && v !== null ? (v as Obj) : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const body = obj(await res.json().catch(() => null));
const data = obj(body.data);
const scope = obj(data.scope);
const prs = list(scope.nodes);
const threads = prs.map((p) => list(obj(obj(p).reviewThreads).nodes).length);
const max = (a: number[]) => a.reduce((m, n) => Math.max(m, n), 0);

console.log(
  JSON.stringify(
    {
      http: res.status,
      withQ: q !== '',
      latencyMs,
      errors: list(body.errors).map((e) => ({
        type: obj(e).type,
        message: obj(e).message,
      })),
      viewer: obj(data.viewer).login ?? null,
      candidates: prs.length,
      issueCount: scope.issueCount ?? null,
      threadsFetched: threads.reduce((a, b) => a + b, 0),
      maxThreadsOnAPR: max(threads),
      matched: data.matched ? list(obj(data.matched).nodes).length : null,
      rateLimit: data.rateLimit ?? null,
    },
    null,
    2,
  ),
);
