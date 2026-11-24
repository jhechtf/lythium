import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['main.ts'],
  // main.ts statically imports smee-client (a devDependency, only used when
  // IS_DEV). It has always been bundled into dist; keep that and silence the
  // tsdown bundled-dependency check (deps.onlyBundle, formerly inlineOnly), which is a hard error under CI.
  deps: { onlyBundle: false },
});
