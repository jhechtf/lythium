export interface StackMember {
  prNumber: number;
  isCurrent: boolean;
  position: number;
}

const STACK_RE =
  /<!-- lythium-stack-start -->([\s\S]*?)<!-- lythium-stack-end -->/;

// Matches: [branch](url) (#123) with optional bold markers and ← this PR
const PR_LINE_RE = /\(#(\d+)\)/;
const CURRENT_RE = /← this PR/;
// Trunk lines look like: `branchname` (trunk) — no PR number, skip them
const TRUNK_RE = /`[^`]+`\s*\(trunk\)/;

export function parseStackSection(
  body: string | null | undefined,
): StackMember[] {
  if (!body) return [];

  const match = STACK_RE.exec(body);
  if (!match) return [];

  const lines = match[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '));

  const members: StackMember[] = [];
  let position = 0;

  for (const line of lines) {
    if (TRUNK_RE.test(line)) {
      position++;
      continue;
    }

    const prMatch = PR_LINE_RE.exec(line);
    if (!prMatch) {
      position++;
      continue;
    }

    members.push({
      prNumber: Number(prMatch[1]),
      isCurrent: CURRENT_RE.test(line),
      position: position++,
    });
  }

  return members;
}
