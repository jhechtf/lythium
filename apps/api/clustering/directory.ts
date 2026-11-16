/**
 * Deterministic grouping by directory: the `directory` strategy, and the
 * fallback when no model is configured or the model fails. No model call.
 *
 * Files are grouped by their first `depth` path segments, starting at 2 and
 * dropping to 1 when that makes too many groups. When there are still more
 * than `max` groups, the smallest are folded into one "Other changes" group.
 * Root-level files form a "Top-level files" group.
 *
 * Confidence: 100 for a group that is exactly one directory (the grouping is
 * literal, not a guess); for "Other changes", the share of its files in its
 * most common top-level directory, since that group is a catch-all.
 */

export interface DirectoryGroup {
  name: string;
  description: string;
  paths: string[];
  confidence: number;
}

const OTHER = 'Other changes';

function dirKey(path: string, depth: number): string {
  const parts = path.split('/');
  if (parts.length === 1) return '';
  return parts.slice(0, Math.min(depth, parts.length - 1)).join('/');
}

function bucket(paths: string[], depth: number) {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const key = dirKey(p, depth);
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }
  return groups;
}

export function groupByDirectory(
  paths: string[],
  target: { min: number; max: number },
): DirectoryGroup[] {
  if (paths.length === 0) return [];
  let groups = bucket(paths, 2);
  if (groups.size > target.max) groups = bucket(paths, 1);

  // Largest first; ties by name so the output is stable.
  let entries = [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  let other: string[] = [];
  if (entries.length > target.max) {
    const keep = Math.max(target.max - 1, 1);
    other = entries.slice(keep).flatMap(([, ps]) => ps);
    entries = entries.slice(0, keep);
  }

  const out: DirectoryGroup[] = entries.map(([dir, ps]) => ({
    name: dir === '' ? 'Top-level files' : dir,
    description:
      dir === '' ? 'Files at the repository root' : `Changes under ${dir}/`,
    paths: ps,
    confidence: 100,
  }));
  if (other.length > 0) {
    const tops = bucket(other, 1);
    const largest = Math.max(...[...tops.values()].map((ps) => ps.length));
    out.push({
      name: OTHER,
      description: 'Smaller directories, combined',
      paths: other,
      confidence: Math.round((largest / other.length) * 100),
    });
  }
  return out;
}
