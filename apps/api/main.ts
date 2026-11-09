import { serve } from '@hono/node-server';
import { app } from './app.ts';

export type { AppType } from './app.ts';

const port = Number(process.env.PORT ?? 3000);
console.log(`API server listening on :${port}`);
serve({ fetch: app.fetch, port });
