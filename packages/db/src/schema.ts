import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
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

// ---------------------------------------------------------------------------
// Guided review state (LYT-60)
//
// Groups are shared per PR; reviewed and viewed marks are private per GitHub
// user (numeric id from `GET /user`). Everything is pinned to the PR head sha
// it was made at: when the head moves, state for older shas is discarded and
// groups are rebuilt.
// ---------------------------------------------------------------------------

export const reviewGroups = pgTable(
  'review_groups',
  {
    id: serial('id').primaryKey(),
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
    prNumber: integer('pr_number').notNull(),
    headSha: text('head_sha').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    position: integer('position').notNull(),
    /** `manual` (a person) or `ai` (guided clustering). */
    source: text('source').notNull(),
    /** GitHub user id of the creator; null for AI-generated groups. */
    createdBy: bigint('created_by', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('review_groups_pr_idx').on(t.owner, t.repo, t.prNumber, t.headSha),
    check('review_groups_source_check', sql`${t.source} in ('manual', 'ai')`),
  ],
);

/** A file in a group, optionally narrowed to a line range of the new file. */
export const reviewGroupFiles = pgTable(
  'review_group_files',
  {
    id: serial('id').primaryKey(),
    groupId: integer('group_id')
      .notNull()
      .references(() => reviewGroups.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    startLine: integer('start_line'),
    endLine: integer('end_line'),
  },
  (t) => [
    index('review_group_files_group_idx').on(t.groupId),
    check(
      'review_group_files_range_check',
      sql`(${t.startLine} is null and ${t.endLine} is null) or (${t.startLine} >= 1 and ${t.endLine} >= ${t.startLine})`,
    ),
  ],
);

/** A user marked a group reviewed. Removed with the group. */
export const reviewGroupReviews = pgTable(
  'review_group_reviews',
  {
    groupId: integer('group_id')
      .notNull()
      .references(() => reviewGroups.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

/** A user marked a file viewed at a given head sha. */
export const reviewViewedFiles = pgTable(
  'review_viewed_files',
  {
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
    prNumber: integer('pr_number').notNull(),
    headSha: text('head_sha').notNull(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    path: text('path').notNull(),
    viewedAt: timestamp('viewed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.owner, t.repo, t.prNumber, t.userId, t.headSha, t.path],
    }),
  ],
);
