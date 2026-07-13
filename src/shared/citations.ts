import type { Citation } from "./contracts";

export interface CitationSource {
  chunk_id: string;
  page: number;
  text: string;
}

export function extractCitations(
  content: string,
  sources: CitationSource[],
): Citation[] {
  const pages = new Set<number>();
  const pattern = /【(?:p\.?|第)\s*(\d+)\s*(?:页)?】/gi;
  for (const match of content.matchAll(pattern)) pages.add(Number(match[1]));
  return [...pages]
    .sort((a, b) => a - b)
    .map((page) => {
      const source = sources.find((item) => item.page === page);
      return {
        page,
        chunkId: source?.chunk_id,
        excerpt: source?.text.slice(0, 180),
      };
    });
}
