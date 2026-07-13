import type { ComparisonCitation, ComparisonReport, Paper } from "./contracts";

export interface ComparisonSource {
  paperId: string;
  paperLabel: string;
  chunk_id: string;
  page: number;
  text: string;
}

export function extractComparisonCitations(
  content: string,
  sources: ComparisonSource[],
): ComparisonCitation[] {
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

export function comparisonReportFileName(report: ComparisonReport): string {
  const normalized = report.question
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[.\s]+$/g, "")
    .trim()
    .slice(0, 90);
  return `${normalized || "PaperXcel-comparison"}.md`;
}

export function buildComparisonReportExport(
  report: ComparisonReport,
  papers: Paper[],
): string {
  const paperById = new Map(papers.map((paper) => [paper.id, paper]));
  const paperLines = report.paperIds.map((paperId, index) => {
    const paper = paperById.get(paperId);
    if (!paper) return `- P${index + 1}: 已移除文献`;
    const details = [
      paper.authors.length ? paper.authors.join(", ") : "",
      paper.journal,
      paper.year,
      paper.doi,
    ].filter(Boolean);
    return `- P${index + 1}: ${paper.title}${details.length ? ` (${details.join(" · ")})` : ""}`;
  });

  return [
    "# 跨文献研究矩阵",
    "",
    `**研究问题：** ${report.question}`,
    `**生成时间：** ${report.createdAt}`,
    `**模型：** ${report.model}`,
    "",
    "## 纳入文献",
    "",
    ...paperLines,
    "",
    "---",
    "",
    report.content.trim(),
    "",
  ].join("\n");
}
