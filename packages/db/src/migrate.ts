import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

// biome-ignore lint/style/noNonNullAssertion: I ain't typin this shit.
const db = drizzle(process.env.DB_URL!);

async function main() {
  console.info('Running migrations...');
  await migrate(db, { migrationsFolder: './drizzle' });
}

// Run the main function
main();
