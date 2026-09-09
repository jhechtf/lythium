import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// biome-ignore lint/style/noNonNullAssertion: I ain't typin this shit.
const client = postgres(process.env.DB_URL!, { max: 1 });
const db = drizzle(client);

async function main() {
  console.info('Running migrations...');
  try {
    await migrate(db, { migrationsFolder: './drizzle' });
  } finally {
    await client.end();
  }
}

// Run the main function
main();
