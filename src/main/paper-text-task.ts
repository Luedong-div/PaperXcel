import { stat } from "node:fs/promises";
import type { PaperTextUpdate } from "../shared/paperText";
import { PaperTextDraftWriter, type PaperTextDraft } from "./paper-text-drafts";

export interface PaperTextTaskOptions<T> {
  paperId: string;
  pdfPath: string;
  directory: string;
  model: string;
  pageCount: number;
  kind: PaperTextDraft["kind"];
  signal: AbortSignal;
  initialUpdate?: PaperTextUpdate;
  onStart?: () => Promise<void>;
  onUpdate?: (
    update: PaperTextUpdate,
    status?: "complete" | "interrupted" | "error",
  ) => void;
  onCommit?: () => void;
  operation: (update: (value: PaperTextUpdate) => void) => Promise<T>;
  commit: (result: T) => Promise<void>;
}

/** One owner for streamed text, durable recovery, cancellation and final commit. */
export async function runPaperTextTask<T>(
  options: PaperTextTaskOptions<T>,
): Promise<T> {
  options.signal.throwIfAborted();
  const source = await stat(options.pdfPath);
  options.signal.throwIfAborted();
  const writer = new PaperTextDraftWriter(
    options.directory,
    options.kind === "repair",
  );
  let latest: PaperTextUpdate | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const draft = (status: PaperTextDraft["status"]): PaperTextDraft => ({
    version: 1,
    kind: options.kind,
    paperId: options.paperId,
    source: { size: source.size, mtimeMs: source.mtimeMs },
    model: options.model,
    pageCount: latest?.unit === "pages" ? latest.total : options.pageCount,
    updatedAt: new Date().toISOString(),
    status,
    update: latest!,
  });
  const publish = (status?: "complete" | "interrupted" | "error") => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (latest) options.onUpdate?.(latest, status);
  };
  const update = (value: PaperTextUpdate) => {
    if (finished || options.signal.aborted) return;
    const milestone =
      !latest ||
      latest.completed !== value.completed ||
      latest.currentPage !== value.currentPage ||
      latest.batchStartPage !== value.batchStartPage ||
      latest.change?.id !== value.change?.id ||
      latest.phase !== value.phase;
    latest = value;
    writer.update(draft("running"));
    if (milestone) publish();
    else if (!timer) {
      timer = setTimeout(() => publish(), 40);
      timer.unref?.();
    }
  };
  try {
    if (options.initialUpdate) {
      update(options.initialUpdate);
      // Replace the canonical Markdown before opening the model request. This
      // first write cannot wait for the token coalescing timer.
      await writer.flush();
    }
    await options.onStart?.();
    options.signal.throwIfAborted();
    const result = await abortableTask(
      () => options.operation(update),
      options.signal,
    );
    finished = true;
    options.signal.throwIfAborted();
    await writer.flush();
    options.signal.throwIfAborted();
    options.onCommit?.();
    // Commit begins only after accepting a complete provider response. Callers
    // lock cancellation here so cache, index and saved note finish together.
    await options.commit(result);
    await writer.remove(options.kind);
    finished = true;
    publish("complete");
    return result;
  } catch (error) {
    finished = true;
    const status = options.signal.aborted ? "interrupted" : "error";
    if (latest) {
      latest = {
        ...latest,
        detail:
          status === "interrupted"
            ? "已停止，已生成内容已写入 Markdown 并保留为草稿"
            : error instanceof Error
              ? error.message
              : String(error),
      };
      writer.update(draft(status));
      await writer.flush();
      publish(status);
    }
    throw error;
  } finally {
    finished = true;
    if (timer) clearTimeout(timer);
  }
}

function abortableTask<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
