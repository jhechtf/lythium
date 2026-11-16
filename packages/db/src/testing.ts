import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { ReviewDb } from './review-state';
import * as schema from './schema';

/**
 * Test helpers: an in-process Postgres (PGlite) with the real migrations
 * applied. Exported as `@lythium/db/testing` so apps test against this
 * package's copy of drizzle-orm (a second copy makes the types incompatible).
 * PGlite is a dev dependency: never import this from runtime code.
 */

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

export async function createTestDb(): Promise<ReviewDb> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder });
  return db;
}

/** Empty every guided-review table (call between tests). */
export async function resetReviewState(db: ReviewDb) {
  await db.execute(
    sql`truncate review_groups, review_group_files, review_group_reviews, review_viewed_files, review_pr_heads restart identity cascade`,
  );
}
