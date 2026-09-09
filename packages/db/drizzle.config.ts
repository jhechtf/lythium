import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle',
  dialect: 'postgresql',
  schema: './src/schema.ts',

  dbCredentials: {
    // biome-ignore lint/style/noNonNullAssertion: DB_URL is required at drizzle-kit runtime.
    url: process.env.DB_URL!,
  },

  extensionsFilters: ['postgis'],
  schemaFilter: 'public',
  tablesFilter: '*',

  introspect: {
    casing: 'camel',
  },

  migrations: {
    prefix: 'timestamp',
    schema: 'public',
  },
});
