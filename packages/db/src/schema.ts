import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

export const pullRequests = pgTable(
  'pull_requests',
  {
    id: serial('id').primaryKey(),
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
    prNumber: integer('pr_number').notNull(),
    title: text('title').notNull(),
    state: text('state').notNull(),
    headRef: text('head_ref').notNull(),
    baseRef: text('base_ref').notNull(),
    htmlUrl: text('html_url').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [unique().on(t.owner, t.repo, t.prNumber)],
);

export const stackMembers = pgTable(
  'stack_members',
  {
    id: serial('id').primaryKey(),
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
    sourcePrNumber: integer('source_pr_number').notNull(),
    memberPrNumber: integer('member_pr_number').notNull(),
    position: integer('position').notNull(),
    isCurrent: boolean('is_current').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique().on(t.owner, t.repo, t.sourcePrNumber, t.memberPrNumber)],
);
