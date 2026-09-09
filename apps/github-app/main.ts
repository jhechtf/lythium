import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import SmeeClient from 'smee-client';
import { serve } from '@hono/node-server';
import { createDb, pullRequests, stackMembers } from '@lythium/db';
import { App } from '@octokit/app';
import type { EmitterWebhookEventName } from '@octokit/webhooks';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { parseStackSection } from './lib/parser.ts';

const IS_DEV = process.env.NODE_ENV !== 'production';
const SMEE_PROXY = IS_DEV ? process.env.SMEE_PROXY : undefined;
const DATABASE_URL = process.env.DATABASE_URL;
const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY;
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!GITHUB_APP_ID) throw new Error('GITHUB_APP_ID is required');
if (!GITHUB_APP_PRIVATE_KEY)
  throw new Error('GITHUB_APP_PRIVATE_KEY is required');
if (!GITHUB_WEBHOOK_SECRET)
  throw new Error('GITHUB_WEBHOOK_SECRET is required');

const { db } = createDb(DATABASE_URL);

const GH_PRIVATE_KEY_CONTENTS = await readFile(
  GITHUB_APP_PRIVATE_KEY,
  'utf-8',
).then((r) => r.toString());

const HANDLED_ACTIONS = new Set([
  'opened',
  'edited',
  'synchronize',
  'reopened',
  'closed',
]);

const githubApp = new App({
  appId: GITHUB_APP_ID,
  privateKey: GH_PRIVATE_KEY_CONTENTS,
  webhooks: { secret: GITHUB_WEBHOOK_SECRET },
});

githubApp.webhooks.on('pull_request', async ({ payload }) => {
  if (!HANDLED_ACTIONS.has(payload.action)) return;

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pr = payload.pull_request;

  await db
    .insert(pullRequests)
    .values({
      owner,
      repo,
      prNumber: pr.number,
      title: pr.title,
      state: pr.state,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      htmlUrl: pr.html_url,
      createdAt: new Date(pr.created_at),
      updatedAt: new Date(pr.updated_at),
    })
    .onConflictDoUpdate({
      target: [pullRequests.owner, pullRequests.repo, pullRequests.prNumber],
      set: {
        title: pr.title,
        state: pr.state,
        headRef: pr.head.ref,
        baseRef: pr.base.ref,
        htmlUrl: pr.html_url,
        updatedAt: new Date(pr.updated_at),
      },
    });

  const members = parseStackSection(pr.body);

  await db
    .delete(stackMembers)
    .where(
      and(
        eq(stackMembers.owner, owner),
        eq(stackMembers.repo, repo),
        eq(stackMembers.sourcePrNumber, pr.number),
      ),
    );

  if (members.length > 0) {
    await db.insert(stackMembers).values(
      members.map((m) => ({
        owner,
        repo,
        sourcePrNumber: pr.number,
        memberPrNumber: m.prNumber,
        position: m.position,
        isCurrent: m.isCurrent,
      })),
    );
  }
});

githubApp.webhooks.onError((error) => {
  console.error('Webhook error:', error);
});

const honoApp = new Hono()
  .get('/health', (c) => c.json({ ok: true }))
  .post('/webhook', async (c) => {
    try {
      await githubApp.webhooks.verifyAndReceive({
        id: c.req.header('x-github-delivery') ?? '',
        name: c.req.header('x-github-event') as EmitterWebhookEventName,
        payload: await c.req.text(),
        signature: c.req.header('x-hub-signature-256') ?? '',
      });
      return c.json({ ok: true });
    } catch {
      return c.json({ error: 'Webhook verification failed' }, 400);
    }
  });

export type AppType = typeof honoApp;

const port = Number(process.env.PORT ?? 3001);
if (IS_DEV && import.meta.main) {

  const smee = new SmeeClient({
    // biome-ignore lint/style/noNonNullAssertion: it's either going to be set or it won't work
    source: SMEE_PROXY!,
    target: 'http://localhost:3001/webhook',
    logger: console,
  });

  console.info('Forwarding Webhook Traffic in dev');
  await smee.start();
  process.on('beforeExit', () => {
    console.info('Stopping Smee port forwarding');
    smee.stop();
  });
}

console.log(`GitHub App webhook server listening on :${port}`);
serve({ fetch: honoApp.fetch, port });
