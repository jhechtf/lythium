import { REVIEW_LIMITS } from '@lythium/db';
import type { PRFile } from '../pr-files.ts';
import type {
  ClusterGranularity,
  ClusterStrategy,
  GeneratedGroup,
  GenerateFallbackReason,
} from '../types.ts';
import {
  type Clusterer,
  type ClusterFile,
  ClusterRefusedError,
  type DraftGroup,
  escapeData,
} from './clusterer.ts';
import { groupByDirectory } from './directory.ts';

/**
 * Generate review groups for a PR (LYT-63). Nothing here touches the
 * database: the result is a preview the client accepts through
 * `PUT …/groups` with `source: 'ai'`.
 *
 * Guarantees, whatever the model returns: every changed file is in exactly
 * one group, every path is one of the PR's, names and descriptions fit the
 * data layer's caps, and confidence is an integer 0–100.
 */

export const GRANULARITY: Record<
  ClusterGranularity,
  { min: number; max: number }
> = {
  coarse: { min: 2, max: 4 },
  balanced: { min: 4, max: 6 },
  fine: { min: 6, max: 10 },
};

/**
 * Input size. Each file is sent with its path, stats and the first
 * `excerptLines` lines of its patch (at most `excerptChars`). Files are
 * packed into chunks of at most `chunkFiles` files and `chunkChars`
 * characters, clustered in parallel (`concurrency` at a time), and the
 * chunks' groups are merged in one more call. If that would take more than
 * `maxChunks` chunks, excerpts are dropped and only paths and stats are sent;
 * if that still doesn't fit (very long paths), the PR is grouped by directory
 * (`too_large`). So a generation makes at most `maxChunks` + 1 model calls.
 */
export const CLUSTER_LIMITS = {
  excerptLines: 40,
  excerptChars: 1500,
  chunkFiles: 250,
  chunkChars: 60_000,
  maxChunks: 12,
  concurrency: 4,
  /** Sample paths per partial group shown to the merge call. */
  mergeSamplePaths: 8,
} as const;

const UNSORTED = 'Unsorted files';

export interface GenerateInput {
  strategy: ClusterStrategy;
  granularity: ClusterGranularity;
  pr: { title: string; body: string | null };
  files: PRFile[];
  /** `chunkFiles(files)`, when the caller already has it. */
  chunks?: ClusterFile[][];
}

export interface GenerateResult {
  groups: GeneratedGroup[];
  generatedBy: 'model' | 'directory';
  /** The clusterer's name (model id) when the model produced the groups. */
  model: string | null;
  fallbackReason: GenerateFallbackReason | null;
}

export function excerpt(patch: string | undefined): string | undefined {
  if (!patch) return undefined;
  const lines = patch.split('\n');
  let out = lines.slice(0, CLUSTER_LIMITS.excerptLines).join('\n');
  if (out.length > CLUSTER_LIMITS.excerptChars) {
    out = out.slice(0, CLUSTER_LIMITS.excerptChars);
  }
  return lines.length > CLUSTER_LIMITS.excerptLines || out.length < patch.length
    ? `${out}\n…`
    : out;
}

/** Characters a file takes in a prompt, after escaping (`<` → `&lt;`). */
const sizeOf = (f: ClusterFile) =>
  escapeData(f.path).length + escapeData(f.excerpt ?? '').length + 60;

function pack(files: ClusterFile[]): ClusterFile[][] {
  const chunks: ClusterFile[][] = [];
  let current: ClusterFile[] = [];
  let chars = 0;
  for (const f of files) {
    const size = sizeOf(f);
    if (
      current.length > 0 &&
      (current.length >= CLUSTER_LIMITS.chunkFiles ||
        chars + size > CLUSTER_LIMITS.chunkChars)
    ) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(f);
    chars += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Split files into chunks. Files are sorted by path first so a chunk holds
 * neighboring directories, which keeps related files in the same call.
 */
export function chunkFiles(prFiles: PRFile[]): ClusterFile[][] {
  const files: ClusterFile[] = prFiles
    .map((f, id) => ({
      id,
      path: f.path,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      excerpt: excerpt(f.patch),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const chunks = pack(files);
  if (chunks.length <= CLUSTER_LIMITS.maxChunks) return chunks;
  return pack(files.map(({ excerpt: _, ...f }) => f));
}

/** More chunks than the model is sent: `generateGroups` uses directories. */
const tooLarge = (chunks: ClusterFile[][]) =>
  chunks.length > CLUSTER_LIMITS.maxChunks;

/**
 * Model calls a generation over these chunks (from `chunkFiles`) makes: one
 * per chunk, plus a merge when there is more than one, and none when there
 * are too many to send. Rate limits charge this; pass the same chunks to
 * `generateGroups` so the charge matches.
 */
export function modelCalls(chunks: ClusterFile[][]): number {
  if (tooLarge(chunks)) return 0;
  return chunks.length > 1 ? chunks.length + 1 : chunks.length;
}

/**
 * Run `fn` over `items`, at most `limit` at a time, keeping order. After one
 * call fails, no worker starts another: each is a paid model call, and the
 * caller has already fallen back.
 */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

const clampConfidence = (n: unknown) =>
  typeof n === 'number' && Number.isFinite(n)
    ? // 0–100 is the declared scale; a value strictly between 0 and 1 is
      // taken as a fraction. 1 stays 1%.
      Math.min(100, Math.max(0, Math.round(n < 1 && n > 0 ? n * 100 : n)))
    : 0;

const cleanName = (s: string) =>
  s.trim().slice(0, REVIEW_LIMITS.nameLength) || 'Untitled group';

const cleanDescription = (s: string) =>
  s.trim().slice(0, REVIEW_LIMITS.descriptionLength) || null;

/**
 * Turn the model's groups into a valid cover of the PR: unknown ids are
 * dropped, a file claimed twice stays in the first group, empty groups go,
 * and files nobody claimed land in an "Unsorted files" group (confidence 0).
 */
export function normalize(
  drafts: DraftGroup[],
  prFiles: PRFile[],
): GeneratedGroup[] {
  const seen = new Set<number>();
  const kept: { draft: DraftGroup; ids: number[] }[] = [];
  // Keep room for the unsorted group under the data layer's group cap;
  // files of groups past it end up unsorted.
  const cap = REVIEW_LIMITS.groupsPerPR - 1;
  for (const d of drafts) {
    if (kept.length >= cap) break;
    const ids: number[] = [];
    for (const id of d.fileIds) {
      if (!Number.isInteger(id) || id < 0 || id >= prFiles.length) continue;
      if (seen.has(id)) continue; // claimed earlier, or repeated in this group
      seen.add(id);
      ids.push(id);
    }
    if (ids.length > 0) kept.push({ draft: d, ids });
  }
  const groups: GeneratedGroup[] = kept.map(({ draft, ids }) => ({
    name: cleanName(draft.name),
    description: cleanDescription(draft.description),
    files: ids.map((id) => prFiles[id].path),
    confidence: clampConfidence(draft.confidence),
  }));
  const leftover = prFiles.filter((_, id) => !seen.has(id));
  if (leftover.length > 0) {
    groups.push({
      name: UNSORTED,
      description: 'Files the grouping did not place',
      files: leftover.map((f) => f.path),
      confidence: 0,
    });
  }
  return groups;
}

async function clusterWithModel(
  clusterer: Clusterer,
  input: GenerateInput & { strategy: 'feature' | 'layer' },
): Promise<DraftGroup[]> {
  const target = GRANULARITY[input.granularity];
  const chunks = input.chunks ?? chunkFiles(input.files);
  const perChunk = await mapLimited(
    chunks,
    CLUSTER_LIMITS.concurrency,
    (files) =>
      clusterer
        .cluster({ strategy: input.strategy, target, pr: input.pr, files })
        .then((groups) => {
          // A chunk may only claim its own files.
          const own = new Set(files.map((f) => f.id));
          return groups.map((g) => ({
            ...g,
            fileIds: g.fileIds.filter((id) => own.has(id)),
          }));
        }),
  );
  if (perChunk.length === 1) return perChunk[0];

  const partial = perChunk.flat();
  const merged = await clusterer.merge({
    strategy: input.strategy,
    target,
    pr: input.pr,
    groups: partial.map((g, id) => ({
      id,
      name: g.name,
      description: g.description,
      fileCount: g.fileIds.length,
      samplePaths: g.fileIds
        .slice(0, CLUSTER_LIMITS.mergeSamplePaths)
        .map((f) => input.files[f]?.path ?? ''),
    })),
  });
  const used = new Set<number>();
  const out: DraftGroup[] = [];
  for (const m of merged) {
    const sources = m.sourceIds.filter(
      (id) =>
        Number.isInteger(id) && id >= 0 && id < partial.length && !used.has(id),
    );
    for (const id of sources) used.add(id);
    if (sources.length === 0) continue;
    out.push({
      name: m.name,
      description: m.description,
      fileIds: sources.flatMap((id) => partial[id].fileIds),
      confidence: m.confidence,
    });
  }
  // A partial group the merge left out is kept as it was.
  partial.forEach((g, id) => {
    if (!used.has(id)) out.push(g);
  });
  return out;
}

/** Directory grouping, with the same label caps as the model path. */
export function byDirectory(
  input: GenerateInput,
  fallbackReason: GenerateFallbackReason | null,
): GenerateResult {
  const groups = groupByDirectory(
    input.files.map((f) => f.path),
    GRANULARITY[input.granularity],
  ).map((g) => ({
    name: cleanName(g.name),
    description: cleanDescription(g.description),
    files: g.paths,
    confidence: g.confidence,
  }));
  return { groups, generatedBy: 'directory', model: null, fallbackReason };
}

/**
 * Generate groups. `directory` never calls a model. `feature` and `layer`
 * use the clusterer, and fall back to directory grouping when there is no
 * clusterer (`not_configured`), the PR is too large to send (`too_large`),
 * it refuses (`refused`), or it fails (`model_error`). The fallback reason is in the result so the UI can say so.
 */
export async function generateGroups(
  input: GenerateInput,
  clusterer: Clusterer | null,
  log: (msg: string, err: unknown) => void = console.error,
): Promise<GenerateResult> {
  // Nothing to group: no model call.
  if (input.strategy === 'directory' || input.files.length === 0) {
    return byDirectory(input, null);
  }
  if (!clusterer) return byDirectory(input, 'not_configured');
  const chunks = input.chunks ?? chunkFiles(input.files);
  if (tooLarge(chunks)) return byDirectory(input, 'too_large');
  try {
    const drafts = await clusterWithModel(clusterer, {
      ...input,
      chunks,
      strategy: input.strategy,
    });
    return {
      groups: normalize(drafts, input.files),
      generatedBy: 'model',
      model: clusterer.name,
      fallbackReason: null,
    };
  } catch (err) {
    if (err instanceof ClusterRefusedError) {
      return byDirectory(input, 'refused');
    }
    log('AI clustering failed; using directory grouping', err);
    return byDirectory(input, 'model_error');
  }
}
