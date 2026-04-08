export interface GitHubRef {
  ref: string;
  sha: string;
  label: string;
}

export interface StackPR {
  number: number;
  title: string;
  html_url: string;
  head: GitHubRef;
  base: GitHubRef;
}

export interface DiffFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

export interface StackDiff {
  stats: {
    ahead_by: number;
    behind_by: number;
    total_commits: number;
  };
  files: DiffFile[];
}

export interface StackItem {
  pr: StackPR;
  diff: StackDiff;
}

export interface StackDiffResponse {
  stack: StackItem[];
}
