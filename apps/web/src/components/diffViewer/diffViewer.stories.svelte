<script lang="ts" module>
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import DiffViewer from './diffViewer.svelte';
  import type { DiffFile } from '@lythium/api/types';

  const exampleFile: DiffFile = {
    filename: 'src/utils/format.ts',
    status: 'modified',
    additions: 5,
    deletions: 3,
    changes: 8,
    patch: `@@ -1,10 +1,12 @@
 import type { User } from './types';

-export function formatName(user: User) {
-  return user.firstName + ' ' + user.lastName;
+export function formatName(user: User): string {
+  return [user.firstName, user.lastName].filter(Boolean).join(' ');
 }

-export function formatDate(d: Date) {
-  return d.toLocaleDateString();
+export function formatDate(d: Date, locale = 'en-US'): string {
+  return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
+}
+
+export function formatCurrency(amount: number, currency = 'USD'): string {
+  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
 }`,
  };

  const addedFile: DiffFile = {
    filename: 'src/utils/slugify.ts',
    status: 'added',
    additions: 6,
    deletions: 0,
    changes: 6,
    patch: `@@ -0,0 +1,6 @@
+export function slugify(text: string): string {
+  return text
+    .toLowerCase()
+    .trim()
+    .replace(/[^\\w\\s-]/g, '')
+    .replace(/[\\s_-]+/g, '-');
+}`,
  };

  const renamedFile: DiffFile = {
    filename: 'src/utils/helpers.ts',
    previous_filename: 'src/utils/misc.ts',
    status: 'renamed',
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: `@@ -1,5 +1,5 @@
-// Miscellaneous helpers
+// General-purpose helpers

 export function clamp(value: number, min: number, max: number): number {
   return Math.min(Math.max(value, min), max);
 }`,
  };

  const deletedFile: DiffFile = {
    filename: 'src/utils/legacy.ts',
    status: 'removed',
    additions: 0,
    deletions: 12,
    changes: 12,
    patch: `@@ -1,12 +0,0 @@
-// Legacy utilities — no longer used
-import type { User } from './types';
-
-export function getFullName(user: User): string {
-  return user.firstName + ' ' + user.lastName;
-}
-
-export function toUpperSnake(str: string): string {
-  return str
-    .replace(/([a-z])([A-Z])/g, '$1_$2')
-    .toUpperCase();
-}`,
  };

  const { Story } = defineMeta({
    component: DiffViewer,
    args: {
      file: exampleFile,
    },
  });
</script>

<Story name="Modified" args={{ file: exampleFile }} />
<Story name="Added" args={{ file: addedFile }} />
<Story name="Renamed" args={{ file: renamedFile }} />
<Story name="Deleted" args={{ file: deletedFile }} />