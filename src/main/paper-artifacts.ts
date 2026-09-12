import { access, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DocumentPageText, Paper, PaperNote } from "../shared/contracts";
import { buildPaperFullTextMarkdown } from "../shared/knowledge";
import { buildPaperNoteExport } from "../shared/notes";
import type { KnowledgeMarkdownRepairCache } from "./knowledge-markdown-cache";
import { writeCancellableUtf8 } from "./cancellable-file";

export function paperArtifactDirectory(
  userDataPath: string,
  paperId: string,
): string {
  const normalizedId = paperId.trim();
  if (
    !normalizedId ||
    normalizedId === "." ||
    normalizedId === ".." ||
    /[\\/]/.test(normalizedId)
  ) {
    throw new Error("无效的论文 ID。");
  }
  return join(userDataPath, "library", normalizedId);
}

export async function ensureCanonicalPaperPdf(
  directory: string,
  sourcePath: string,
): Promise<string> {
  const targetPath = join(directory, "source.pdf");
  await mkdir(directory, { recursive: true });
  if (resolve(sourcePath) === resolve(targetPath)) return targetPath;
  try {
    await access(targetPath);
  } catch {
    await copyFile(sourcePath, targetPath);
  }
  return targetPath;
}

export async function writePaperMetadataArtifact(
  directory: string,
  paper: Paper,
): Promise<void> {
  await writeJson(join(directory, "metadata.json"), {
    format: "paperxcel-paper-metadata",
    version: 1,
    updated_at: paper.updatedAt,
    paper,
  });
}

export async function writePaperNoteArtifact(
  directory: string,
  paper: Paper,
  note: PaperNote | null,
): Promise<void> {
  const path = join(directory, "notes.md");
  if (!note?.content.trim()) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(directory, { recursive: true });
  await writeFile(path, buildPaperNoteExport(paper, note), "utf8");
}

export async function writePaperTextArtifacts(
  directory: string,
  paper: Paper,
  options: {
    rawPages?: DocumentPageText[];
    repair?: KnowledgeMarkdownRepairCache | null;
    signal?: AbortSignal;
  },
): Promise<void> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const rawPages = options.rawPages?.map((page) => ({ ...page }));
  const repairedMarkdown = options.repair?.markdown.trim();
  if (!repairedMarkdown && !rawPages?.length) return;

  await mkdir(directory, { recursive: true });
  signal?.throwIfAborted();
  const generatedAt = new Date().toISOString();
  const writes: Array<Promise<void>> = [];

  if (options.repair && repairedMarkdown) {
    writes.push(
      writeCancellableUtf8(
        join(directory, "full.md"),
        ensureTrailingNewline(repairedMarkdown),
        signal,
      ),
      writeJson(
        join(directory, "content.json"),
        {
          format: "paperxcel-document-markdown",
          version: 2,
          paper_id: paper.id,
          generated_at: generatedAt,
          parser: "AI repair of PaperXcel full.md",
          page_count: options.repair.pageCount,
          ai_repaired: true,
          model: options.repair.model,
          protocol: options.repair.protocol,
          repaired_at: options.repair.repairedAt,
          markdown: ensureTrailingNewline(repairedMarkdown),
        },
        signal,
      ),
    );
  } else if (rawPages?.length) {
    writes.push(
      writeCancellableUtf8(
        join(directory, "full.md"),
        buildPaperFullTextMarkdown(paper, rawPages),
        signal,
      ),
      writeJson(
        join(directory, "content.json"),
        {
          format: "paperxcel-document-pages",
          version: 1,
          paper_id: paper.id,
          generated_at: generatedAt,
          parser: "PaperXcel PDF.js layout reconstruction",
          page_count: rawPages.length,
          ai_repaired: false,
          pages: rawPages,
        },
        signal,
      ),
      rm(join(directory, "full.raw.md"), { force: true }),
      rm(join(directory, "content.raw.json"), { force: true }),
    );
  }

  if (options.repair && repairedMarkdown && rawPages?.length) {
    writes.push(
      writeCancellableUtf8(
        join(directory, "full.raw.md"),
        buildPaperFullTextMarkdown(paper, rawPages),
        signal,
      ),
      writeJson(
        join(directory, "content.raw.json"),
        {
          format: "paperxcel-document-pages",
          version: 1,
          paper_id: paper.id,
          generated_at: generatedAt,
          parser: "PaperXcel PDF.js layout reconstruction",
          page_count: rawPages.length,
          pages: rawPages,
        },
        signal,
      ),
    );
  }

  await Promise.all(writes);
  signal?.throwIfAborted();
}

export async function removePaperTextArtifacts(
  directory: string,
): Promise<void> {
  await Promise.all(
    [
      "full.md",
      "full.raw.md",
      "content.json",
      "content.raw.json",
      "ai_repair.json",
    ].map((name) => rm(join(directory, name), { force: true })),
  );
}

export async function removeLegacyPaperSummaryArtifact(
  directory: string,
): Promise<void> {
  await rm(join(directory, "summary.json"), { force: true });
}

async function writeJson(
  path: string,
  value: unknown,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });
  signal?.throwIfAborted();
  await writeCancellableUtf8(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
    signal,
  );
}

function ensureTrailingNewline(value: string): string {
  return `${value.trimEnd()}\n`;
}
