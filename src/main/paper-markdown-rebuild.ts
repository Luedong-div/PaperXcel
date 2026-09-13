import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { PaperTextUpdate } from "../shared/paperText";
import { readPaperTextDraft } from "./paper-text-drafts";
import { removeKnowledgeMarkdownRepairCache } from "./knowledge-markdown-cache";

/** Only an explicit retry may reuse previously accepted PDF batches. */
export async function readPaperMarkdownRebuildStart(options: {
  directory: string;
  paperId: string;
  pdfPath: string;
  model: string;
  pageCount: number;
  mode: "restart" | "retry";
}): Promise<PaperTextUpdate> {
  const draft =
    options.mode === "retry"
      ? await readPaperTextDraft(
          options.directory,
          "repair",
          options.paperId,
          options.pdfPath,
        )
      : null;
  const old = draft?.update;
  const resumable =
    old?.mode === "pdf-rebuild" &&
    old.unit === "pages" &&
    old.batchStartPage !== undefined &&
    old.batchEndPage !== undefined &&
    typeof old.committedContent === "string" &&
    Number.isInteger(old.completed) &&
    old.completed >= 0 &&
    old.completed <= old.total &&
    (old.completed % 10 === 0 || old.completed === old.total);
  const completed = resumable ? old.completed : 0;
  const total = resumable ? old.total : options.pageCount;
  const content = resumable ? old.committedContent! : "";
  return {
    mode: "pdf-rebuild",
    unit: "pages",
    phase: "preparing",
    content,
    committedContent: content,
    completed,
    total,
    currentPage: completed + 1,
    batchStartPage: completed + 1,
    batchEndPage: Math.min(completed + 10, total || completed + 10),
    skippedPages: resumable
      ? (old.skippedPages?.filter((page) => page <= completed) ?? [])
      : [],
    reportingSummaryActive: resumable ? old.reportingSummaryActive : undefined,
    reportingSummaryLevel: resumable ? old.reportingSummaryLevel : undefined,
    detail: completed
      ? `保留已完成的 ${completed} 页，正在重试后续批次`
      : "正在清空 Markdown 并打开原始 PDF，每批读取最多 10 页",
  };
}

/** Retire old generated text so preview/startup cannot resurrect it mid-run. */
export async function clearPaperMarkdownRebuildArtifacts(
  directory: string,
  paperId: string,
  legacyCacheRoot?: string,
): Promise<void> {
  await removeKnowledgeMarkdownRepairCache(directory, paperId, legacyCacheRoot);
  await Promise.all(
    ["full.raw.md", "content.raw.json", "content.json"].map((name) =>
      rm(join(directory, name), { force: true }),
    ),
  );
}
