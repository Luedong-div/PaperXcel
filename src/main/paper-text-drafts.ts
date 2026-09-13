import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PaperTextUpdate } from "../shared/paperText";
import { writeCancellableUtf8 } from "./cancellable-file";
import { scanPaperMarkdownContent } from "../shared/paperMarkdownContent";

export interface PaperTextDraft {
  version: 1;
  kind: "repair" | "note";
  paperId: string;
  model: string;
  pageCount: number;
  source: { size: number; mtimeMs: number };
  updatedAt: string;
  status: "running" | "interrupted" | "error";
  update: PaperTextUpdate;
}

function draftPath(directory: string, kind: PaperTextDraft["kind"]): string {
  return join(
    directory,
    kind === "repair" ? "full.repair-draft.json" : "note.generation-draft.json",
  );
}

export async function readPaperTextDraft(
  directory: string,
  kind: PaperTextDraft["kind"],
  paperId: string,
  pdfPath: string,
  options: { persistContentCleanup?: boolean } = {},
): Promise<PaperTextDraft | null> {
  let serialized: string;
  try {
    serialized = await readFile(draftPath(directory, kind), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let draft: PaperTextDraft;
  try {
    draft = JSON.parse(serialized) as PaperTextDraft;
  } catch {
    return null;
  }
  if (
    !draft ||
    typeof draft !== "object" ||
    Array.isArray(draft) ||
    draft.version !== 1 ||
    draft.paperId !== paperId ||
    draft.kind !== kind ||
    typeof draft.update?.content !== "string" ||
    !["running", "interrupted", "error"].includes(draft.status) ||
    !Number.isFinite(draft.update.completed) ||
    !Number.isFinite(draft.update.total)
  )
    return null;
  const source = await stat(pdfPath);
  if (
    source.size !== draft.source?.size ||
    source.mtimeMs !== draft.source?.mtimeMs
  )
    return null;
  if (kind === "repair" && draft.update.mode === "pdf-rebuild") {
    const content = scanPaperMarkdownContent(draft.update.content);
    const committed =
      draft.update.committedContent === undefined
        ? undefined
        : scanPaperMarkdownContent(draft.update.committedContent);
    if (
      content.content !== draft.update.content ||
      committed?.content !== draft.update.committedContent
    ) {
      draft = {
        ...draft,
        update: {
          ...draft.update,
          content: content.content,
          committedContent: committed?.content,
          skippedPages: [
            ...new Set([
              ...(draft.update.skippedPages ?? []),
              ...content.skippedPages,
              ...(committed?.skippedPages ?? []),
            ]),
          ].sort((a, b) => a - b),
          reportingSummaryActive:
            draft.update.reportingSummaryActive ??
            committed?.reportingSummaryActive,
          reportingSummaryLevel:
            draft.update.reportingSummaryLevel ??
            committed?.reportingSummaryLevel,
        },
      };
      // Previewing a running stream must never overwrite a newer writer snapshot.
      if (options.persistContentCleanup) {
        const signal = new AbortController().signal;
        await writeCancellableUtf8(
          draftPath(directory, kind),
          JSON.stringify(draft),
          signal,
        );
        await writeCancellableUtf8(
          join(directory, "full.md"),
          draft.update.content,
          signal,
        );
      }
    }
  }
  return draft;
}

export async function removePaperTextDraft(
  directory: string,
  kind: PaperTextDraft["kind"],
): Promise<void> {
  await rm(draftPath(directory, kind), { force: true });
}

/** Coalesce token updates on disk, and drain the latest snapshot on stop/failure. */
export class PaperTextDraftWriter {
  private latest?: PaperTextDraft;
  private timer?: ReturnType<typeof setTimeout>;
  private writing = Promise.resolve();
  private dirty = false;
  private writeError?: unknown;

  constructor(
    private readonly directory: string,
    private readonly persistMarkdown = false,
  ) {}

  update(draft: PaperTextDraft): void {
    this.latest = draft;
    this.dirty = true;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        void this.flush().catch((error) => {
          this.writeError = error;
        });
      }, 400);
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const draft = this.dirty ? this.latest : undefined;
    this.dirty = false;
    if (draft) {
      this.writing = this.writing
        .catch(() => undefined)
        .then(async () => {
          await mkdir(this.directory, { recursive: true });
          // A fresh signal requests atomic replacement; stopping model work must
          // still allow its completed text to reach the recovery draft.
          await writeCancellableUtf8(
            draftPath(this.directory, draft.kind),
            JSON.stringify(draft),
            new AbortController().signal,
          );
          if (this.persistMarkdown && draft.kind === "repair") {
            await writeCancellableUtf8(
              join(this.directory, "full.md"),
              draft.update.content,
              new AbortController().signal,
            );
          }
          this.writeError = undefined;
        });
    }
    await this.writing;
    if (this.writeError) throw this.writeError;
  }

  async remove(kind: PaperTextDraft["kind"]): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.dirty = false;
    await this.writing;
    await removePaperTextDraft(this.directory, kind);
  }
}
