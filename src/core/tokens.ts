export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chars = Array.from(text).length;
  return Math.max(1, Math.ceil(chars / 4));
}

export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimateTokens(text) <= maxTokens) return text;
  const marker = "\n\n_[truncated: read HANDOFF.md for the rest]_";
  const maxChars = maxTokens * 4;
  const budget = maxChars - marker.length - 4;
  if (budget < 40) return "[truncated]";
  const slice = text.slice(0, budget);
  const lastBreak = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"));
  const cut = lastBreak > budget * 0.6 ? slice.slice(0, lastBreak) : slice;
  return `${cut.trimEnd()}${marker}`;
}
