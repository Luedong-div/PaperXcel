import { useSyncExternalStore } from "react";
import { LoaderCircle } from "lucide-react";
import type { KnowledgeBaseMarkdownPreview } from "../../shared/contracts";
import { PaperTextStreamController } from "./paperTextStreamController";
import { ChatMarkdown } from "./ChatMarkdown";
import { AgentExecutionTrace } from "./AgentExecutionTrace";

export function PaperRepairStreamView({
  store,
  preview,
  paperId,
  error,
  onRetry,
  onReload,
}: {
  store: PaperTextStreamController;
  preview?: KnowledgeBaseMarkdownPreview;
  paperId: string;
  error?: string;
  onRetry?: () => void;
  onReload?: () => void;
}): React.JSX.Element | null {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const current = snapshot.paperId === paperId ? snapshot : undefined;
  const update = current?.update;
  const content = update ? update.content : preview?.markdown;
  if (content === undefined && !update && !error) return null;
  const running = current?.status === "running";
  const interrupted =
    current?.status === "interrupted" || current?.status === "error";
  const batchStart = update?.batchStartPage;
  const batchEnd = update?.batchEndPage;
  const batchLabel =
    batchStart && batchEnd ? `第 ${batchStart}–${batchEnd} 页` : undefined;
  return (
    <>
      {update && (
        <section
          className="paper-repair-progress"
          aria-label="Markdown 实时重建"
        >
          <div className="paper-text-progress-status" role="status">
            {running && (
              <LoaderCircle className="spin" size={14} aria-hidden="true" />
            )}
            <strong>
              {interrupted
                ? "重建草稿已保留"
                : running
                  ? "正在重建 Markdown"
                  : "重建完成"}
            </strong>
            {update.total > 0 && (
              <span>
                已完成 {update.completed}/{update.total} 页
              </span>
            )}
          </div>
          {update.detail && <p>{update.detail}</p>}
          {batchLabel && running && (
            <small className="paper-text-current-page">
              当前批次：原始 PDF {batchLabel}
            </small>
          )}
          {interrupted && batchLabel && (
            <small className="paper-text-current-page">
              {batchLabel}尚未完成，可以从此批重试。
            </small>
          )}
          <small className="paper-text-skipped">
            跳过图片、参考文献和出版信息
          </small>
          {Boolean(update.skippedPages?.length) && (
            <small className="paper-text-skipped">
              无正文页面：{update.skippedPages?.join("、")}
            </small>
          )}
          <AgentExecutionTrace events={current?.events ?? []} live={running} />
          {error && (
            <p className="paper-text-error" role="alert">
              {error}
            </p>
          )}
          {interrupted && onRetry && (
            <button
              type="button"
              className="secondary-button"
              onClick={onRetry}
            >
              重试此批
            </button>
          )}
        </section>
      )}
      {error && !update && (
        <div className="paper-text-error" role="alert">
          {error}
          {onReload && (
            <button
              type="button"
              className="secondary-button"
              onClick={onReload}
            >
              重新读取
            </button>
          )}
        </div>
      )}
      {content !== undefined && (
        <article className="paper-markdown-document knowledge-markdown">
          <ChatMarkdown content={content} />
        </article>
      )}
    </>
  );
}
