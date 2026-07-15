import type { LibraryCitation } from "./contracts";

export interface LibraryCitationSource {
  paperId: string;
  paperLabel: string;
  chunk_id: string;
  page: number;
  text: string;
}

export function extractLibraryCitations(
  content: string,
  sources: LibraryCitationSource[],
): LibraryCitation[] {
  const references = new Map<string, { paperLabel: string; page: number }>();
  const pattern = /【\s*(P\d+)\s*[,，]?\s*p\.?\s*(\d+)\s*】/gi;
  for (const match of content.matchAll(pattern)) {
    const paperLabel = match[1].toUpperCase();
    const page = Number(match[2]);
    references.set(`${paperLabel}:${page}`, { paperLabel, page });
  }

  return [...references.values()]
    .sort(
      (a, b) =>
        Number(a.paperLabel.slice(1)) - Number(b.paperLabel.slice(1)) ||
        a.page - b.page,
    )
    .flatMap(({ paperLabel, page }) => {
      const source = sources.find(
        (item) => item.paperLabel === paperLabel && item.page === page,
      );
      if (!source) return [];
      return [
        {
          paperId: source.paperId,
          paperLabel,
          page,
          chunkId: source.chunk_id,
          excerpt: source.text.slice(0, 220),
        },
      ];
    });
}
