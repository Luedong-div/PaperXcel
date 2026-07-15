import type {
  DocumentPageText,
  LibraryReview,
  Paper,
} from "./contracts";

export function libraryReviewFileName(review: LibraryReview): string {
  const focus = safePathSegment(review.focus, 80);
  const date = review.createdAt.slice(0, 10);
  return `${focus || "PaperXcel-library-review"}-${date}.md`;
}

export function buildLibraryReviewExport(
  review: LibraryReview,
  papers: Paper[],
): string {
  const paperById = new Map(papers.map((paper) => [paper.id, paper]));
  const sources = review.paperIds.map((paperId, index) => {
    const paper = paperById.get(paperId);
    if (!paper) return `- P${index + 1}: 已删除文献`;
    const details = [
      paper.authors.join(", "),
      paper.journal,
      paper.year,
      paper.doi,
    ].filter(Boolean);
    return `- P${index + 1}: ${paper.title}${details.length ? ` (${details.join(" · ")})` : ""}`;
  });
  return [
    "# 全库文献综述",
    "",
    `**研究焦点：** ${review.focus || "综合梳理当前文献库"}`,
    `**生成时间：** ${review.createdAt}`,
    `**模型：** ${review.model}`,
    `**纳入文献：** ${review.paperIds.length} 篇`,
    "",
    "## 文献范围",
    "",
    ...sources,
    "",
    "---",
    "",
    review.content.trim(),
    "",
  ].join("\n");
}

export function paperExportFolderName(paper: Paper, index: number): string {
  const prefix = String(index + 1).padStart(3, "0");
  return `${prefix}-${safePathSegment(paper.title, 96) || "paper"}`;
}

export function buildPaperFullTextMarkdown(
  paper: Paper,
  pages: DocumentPageText[],
): string {
  const metadata = [
    paper.authors.length ? `**作者：** ${paper.authors.join(", ")}` : "",
    paper.journal ? `**期刊：** ${paper.journal}` : "",
    paper.year ? `**年份：** ${paper.year}` : "",
    paper.doi ? `**DOI：** ${paper.doi}` : "",
    paper.arxivId ? `**arXiv：** ${paper.arxivId}` : "",
  ].filter(Boolean);
  return (
    [
      `# ${paper.title}`,
      "",
      ...metadata,
      "",
      "---",
      "",
      ...[...pages]
        .sort((left, right) => left.page - right.page)
        .flatMap((page) => [
          `## 第 ${page.page} 页`,
          "",
          normalizeMarkdownPageText(page.text) || "_（此页未提取到可用文本）_",
          "",
        ]),
    ]
      .join("\n")
      .trimEnd() + "\n"
  );
}

function normalizeMarkdownPageText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function safePathSegment(value: string, maxLength = 100): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[.\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}
