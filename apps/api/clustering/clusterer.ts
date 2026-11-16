/**
 * Provider-agnostic clustering contract (LYT-63). A `Clusterer` turns a list
 * of changed files into named groups; `generate.ts` owns chunking, merging,
 * validation and fallback, so an implementation only answers one call at a
 * time. Files are referenced by numeric id (their index in the request), not
 * by path: ids are short, and an id the model makes up is easy to drop.
 */

export type ModelStrategy = 'feature' | 'layer';

/**
 * Keep data from closing a prompt's tags or attributes. Shared so chunk
 * sizing in `generate.ts` measures what is actually sent.
 */
export const escapeData = (s: string) =>
  s.replace(/</g, '&lt;').replace(/"/g, '&quot;');

export interface ClusterFile {
  id: number;
  path: string;
  status: string;
  additions: number;
  deletions: number;
  /** The start of the patch, trimmed to the per-file budget. Absent for binary files. */
  excerpt?: string;
}

export interface ClusterRequest {
  strategy: ModelStrategy;
  /** How many groups to aim for. A hint: the model may go outside it. */
  target: { min: number; max: number };
  pr: { title: string; body: string | null };
  files: ClusterFile[];
}

export interface DraftGroup {
  name: string;
  description: string;
  fileIds: number[];
  /** 0–100: the model's estimate that every file belongs under this name. */
  confidence: number;
}

/** Groups from separate chunks, to be merged into one set. */
export interface MergeRequest {
  strategy: ModelStrategy;
  target: { min: number; max: number };
  pr: { title: string; body: string | null };
  /** Each chunk's groups, with ids unique across all chunks. */
  groups: {
    id: number;
    name: string;
    description: string;
    samplePaths: string[];
    fileCount: number;
  }[];
}

export interface MergedGroup {
  name: string;
  description: string;
  /** Ids from `MergeRequest.groups`. */
  sourceIds: number[];
  confidence: number;
}

export interface Clusterer {
  /** Stable name for logs and the response, e.g. the model id. */
  readonly name: string;
  cluster(req: ClusterRequest): Promise<DraftGroup[]>;
  merge(req: MergeRequest): Promise<MergedGroup[]>;
}

/** The model declined (e.g. a safety refusal on every fallback model). */
export class ClusterRefusedError extends Error {}
