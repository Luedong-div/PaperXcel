import type { Paper, PaperMetadata } from "../shared/contracts";

function normalizeComparableDoi(value?: string): string | undefined {
  return value?.trim().toLowerCase() || undefined;
}

function normalizeComparableArxivId(value?: string): string | undefined {
  return value?.trim().replace(/v\d+$/i, "").toLowerCase() || undefined;
}

export function isWeakPaperTitle(title: string, fileName?: string): boolean {
  const normalized = title.trim();
  const fileStem = fileName?.replace(/\.pdf$/i, "").trim();
  return (
    !normalized ||
    normalized === fileStem ||
    normalized.length < 12 ||
    /^(untitled|article|paper|manuscript|pubs\.|www\.|https?:|doi[:\s])/i.test(
      normalized,
    ) ||
    /open access article|authorchoice license|supporting information/i.test(
      normalized,
    )
  );
}

export function findPaperForMetadata(
  papers: Paper[],
  metadata: PaperMetadata,
): Paper | undefined {
  const doi = normalizeComparableDoi(metadata.doi);
  const arxivId = normalizeComparableArxivId(metadata.arxivId);
  return papers.find((paper) => {
    const sameDoi =
      doi !== undefined && normalizeComparableDoi(paper.doi) === doi;
    const sameArxiv =
      arxivId !== undefined &&
      normalizeComparableArxivId(paper.arxivId) === arxivId;
    return sameDoi || sameArxiv;
  });
}

export function mergePaperMetadata(
  paper: Paper,
  metadata: PaperMetadata,
  updatedAt = new Date().toISOString(),
): Paper {
  return {
    ...paper,
    title: isWeakPaperTitle(paper.title, paper.fileName)
      ? metadata.title || paper.title
      : paper.title,
    authors: paper.authors.length ? paper.authors : metadata.authors,
    journal: paper.journal || metadata.journal,
    year: paper.year || metadata.year,
    doi: paper.doi || metadata.doi,
    arxivId: paper.arxivId || metadata.arxivId,
    arxivVersion: paper.arxivVersion || metadata.arxivVersion,
    abstract: paper.abstract || metadata.abstract,
    sourceUrl: paper.sourceUrl || metadata.sourceUrl,
    updatedAt,
  };
}

export function shouldResumePaperProcessing(
  paper: Pick<Paper, "status" | "error">,
  hasLocalPdf: boolean,
): boolean {
  if (!hasLocalPdf) return false;
  return (
    paper.status === "queued" ||
    paper.status === "processing" ||
    (paper.status === "error" && paper.error === "PDF file does not exist.")
  );
}
