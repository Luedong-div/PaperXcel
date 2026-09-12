import type { ReferencedSnippet } from "../shared/contracts";

export interface PaperEvidenceCandidate extends ReferencedSnippet {
  score?: number;
  query?: string;
}

export function mergePaperEvidence(
  candidates: PaperEvidenceCandidate[],
  options: { maxItems?: number; maxCharacters?: number } = {},
): ReferencedSnippet[] {
  const maxItems = Math.max(1, options.maxItems ?? 16);
  const maxCharacters = Math.max(1_000, options.maxCharacters ?? 48_000);
  const seen = new Set<string>();
  const merged: ReferencedSnippet[] = [];
  let characters = 0;

  for (const candidate of [...candidates].sort(
    (left, right) => (right.score ?? 0) - (left.score ?? 0),
  )) {
    const text = candidate.text.trim();
    if (!Number.isInteger(candidate.page) || !text) continue;
    const normalized = text
      .toLocaleLowerCase()
      .replace(/\s+/gu, " ")
      .slice(0, 1_500);
    const key = `${candidate.page}:${normalized}`;
    if (seen.has(key)) continue;
    const remaining = maxCharacters - characters;
    if (remaining <= 0 || merged.length >= maxItems) break;
    const clipped = text.slice(0, Math.min(6_000, remaining));
    if (!clipped) break;
    seen.add(key);
    merged.push({ page: candidate.page, text: clipped });
    characters += clipped.length;
  }

  return merged;
}
