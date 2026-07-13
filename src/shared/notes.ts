import type { Paper, PaperNote } from "./contracts";

export function paperNoteFileName(paper: Paper): string {
  const normalized = paper.title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[.\s]+$/g, "")
    .trim()
    .slice(0, 100);
  return `${normalized || "PaperXcel-note"}.md`;
}

export function buildPaperNoteExport(paper: Paper, note: PaperNote): string {
  const metadata = [
    paper.authors.length ? `**作者：** ${paper.authors.join(", ")}` : "",
    paper.journal ? `**期刊：** ${paper.journal}` : "",
    paper.year ? `**年份：** ${paper.year}` : "",
    paper.doi ? `**DOI：** ${paper.doi}` : "",
  ].filter(Boolean);
  return [
    `# ${paper.title}`,
    "",
    ...metadata,
    "",
    "---",
    "",
    note.content.trim(),
    "",
  ].join("\n");
}
