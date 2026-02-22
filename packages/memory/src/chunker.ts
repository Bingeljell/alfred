export type ChunkedSection = {
  id: string;
  startLine: number;
  endLine: number;
  text: string;
};

function tokenEstimate(line: string): number {
  const trimmed = line.trim();
  if (!trimmed) {
    return 0;
  }
  return trimmed.split(/\s+/).length;
}

export function chunkByApproxTokens(
  input: string,
  options: {
    pathKey: string;
    targetTokens?: number;
    overlapTokens?: number;
  }
): ChunkedSection[] {
  const targetTokens = options.targetTokens ?? 500;
  const overlapTokens = options.overlapTokens ?? 80;

  const lines = input.split(/\r?\n/);
  const lineTokens = lines.map(tokenEstimate);
  const chunks: ChunkedSection[] = [];

  let start = 0;
  while (start < lines.length) {
    let end = start;
    let tokens = 0;

    while (end < lines.length && tokens < targetTokens) {
      tokens += lineTokens[end];
      end += 1;
    }

    const startLine = start + 1;
    const endLine = Math.max(start + 1, end);
    const text = lines.slice(start, end).join("\n").trim();

    if (text) {
      const id = `${options.pathKey}:${startLine}:${endLine}`;
      chunks.push({ id, startLine, endLine, text });
    }

    if (end >= lines.length) {
      break;
    }

    let overlap = 0;
    let nextStart = end;
    while (nextStart > start && overlap < overlapTokens) {
      nextStart -= 1;
      overlap += lineTokens[nextStart];
    }

    start = Math.max(start + 1, nextStart);
  }

  return chunks;
}
