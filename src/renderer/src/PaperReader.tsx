import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, RefreshCw, Sparkles, Square } from "lucide-react";
import type {
  KnowledgeBaseMarkdownPreview,
  KnowledgeBaseMarkdownRepairResult,
  Paper,
  ProviderProfile,
} from "../../shared/contracts";
import {
  DocumentViewToggle,
  type DocumentViewMode,
} from "./DocumentViewToggle";
import { PaperTextStreamController } from "./paperTextStreamController";
import { PaperRepairStreamView } from "./PaperRepairStreamView";
import { PdfViewer, type PdfTextSelection } from "./PdfViewer";

interface PaperReaderProps {
  paper: Paper;
  url: string;
  page: number;
  onPageChange: (page: number) => void;
  onReferenceSelection?: (selection: PdfTextSelection) => void;
  onTranslateSelection?: (selection: PdfTextSelection) => void;
  provider?: ProviderProfile;
  refreshToken?: string;
  onNotice?: (message: string) => void;
  onRepairMarkdown?: (
    paperId: string,
    requestId: string,
    mode?: "restart" | "retry",
  ) => Promise<KnowledgeBaseMarkdownRepairResult>;
  onCancelRepair?: (requestId: string) => Promise<boolean>;
}

export function PaperReader({
  paper,
  url,
  page,
  onPageChange,
  onReferenceSelection,
  onTranslateSelection,
  provider,
  refreshToken,
  onNotice,
  onRepairMarkdown,
  onCancelRepair,
}: PaperReaderProps): React.JSX.Element {
  const [viewMode, setViewMode] = useState<DocumentViewMode>("pdf");
  const [preview, setPreview] = useState<KnowledgeBaseMarkdownPreview>();
  const [loading, setLoading] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairDetail, setRepairDetail] = useState("");
  const [streamStore] = useState(() => new PaperTextStreamController());
  const [error, setError] = useState("");
  const requestSequenceRef = useRef(0);
  const attemptedRebuildRef = useRef(false);
  const activeRepairRequestRef = useRef<string | undefined>(undefined);

  const loadMarkdown = useCallback(async (): Promise<void> => {
    const requestSequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestSequence;
    setLoading(true);
    setError("");
    try {
      const next = await window.paperxcel.knowledgeBase.previewMarkdown(
        paper.id,
        "ai",
      );
      if (requestSequence === requestSequenceRef.current) {
        if (next.draft && next.draft.mode !== "pdf-rebuild") {
          setPreview(undefined);
          streamStore.clear(paper.id);
          attemptedRebuildRef.current = true;
          return;
        }
        setPreview(
          next.aiRepaired || next.draft ? next : { ...next, markdown: "" },
        );
        if (next.draft) {
          streamStore.restore(
            paper.id,
            {
              content: next.markdown,
              phase: "streaming",
              completed: next.draft.completed,
              total: next.draft.total,
              detail: next.draft.detail,
              mode: next.draft.mode,
              unit: next.draft.unit,
              currentPage: next.draft.currentPage,
              batchStartPage: next.draft.batchStartPage,
              batchEndPage: next.draft.batchEndPage,
              skippedPages: next.draft.skippedPages,
            },
            next.draft.status === "running" ? "interrupted" : next.draft.status,
          );
        } else streamStore.clear(paper.id);
      }
    } catch (reason) {
      if (requestSequence === requestSequenceRef.current) {
        setError(errorMessage(reason));
      }
    } finally {
      if (requestSequence === requestSequenceRef.current) setLoading(false);
    }
  }, [paper.id, streamStore]);

  const repairMarkdown = async (
    mode: "restart" | "retry" = "restart",
  ): Promise<void> => {
    if (repairing || !provider?.hasApiKey) return;
    const requestId = crypto.randomUUID();
    activeRepairRequestRef.current = requestId;
    requestSequenceRef.current++;
    attemptedRebuildRef.current = true;
    const previous =
      mode === "retry" ? streamStore.getSnapshot().update : undefined;
    if (mode === "restart") setPreview(undefined);
    setLoading(false);
    setRepairing(true);
    streamStore.start(paper.id, requestId, previous?.content ?? "", {
      ...previous,
      phase: "preparing",
      mode: "pdf-rebuild",
      unit: "pages",
    });
    setRepairDetail(
      mode === "retry"
        ? "正在重试未完成批次"
        : "正在打开原始 PDF，每 10 页一批重新生成",
    );
    setError("");
    try {
      const next = onRepairMarkdown
        ? await onRepairMarkdown(paper.id, requestId, mode)
        : await window.paperxcel.knowledgeBase.repairMarkdown(
            paper.id,
            requestId,
            mode,
          );
      if (activeRepairRequestRef.current !== requestId) return;
      if ("cancelled" in next) {
        const partial =
          next.preview?.draft?.mode === "pdf-rebuild"
            ? next.preview
            : undefined;
        if (partial) setPreview(partial);
        streamStore.finish("interrupted", partial?.markdown);
        onNotice?.("重建已停止，已生成的 Markdown 保留为草稿。");
        return;
      }
      setPreview(next);
      streamStore.finish("complete", next.markdown);
      setError("");
      onNotice?.(
        `论文全文已由 ${next.model || provider.model} 从原始 PDF 重建并缓存。`,
      );
    } catch (reason) {
      if (activeRepairRequestRef.current !== requestId) return;
      const message = errorMessage(reason);
      streamStore.finish("error");
      setError(message);
      onNotice?.(message);
    } finally {
      if (activeRepairRequestRef.current === requestId) {
        activeRepairRequestRef.current = undefined;
        setRepairing(false);
        setLoading(false);
        setRepairDetail("");
      }
    }
  };

  const stopRepair = async (): Promise<void> => {
    const requestId = activeRepairRequestRef.current;
    if (!requestId) return;
    setRepairDetail("正在停止 Markdown 重建");
    try {
      const stopped = onCancelRepair
        ? await onCancelRepair(requestId)
        : await window.paperxcel.knowledgeBase.cancel(requestId);
      if (!stopped && activeRepairRequestRef.current === requestId) {
        setRepairDetail("重建正在完成保存");
      }
    } catch (reason) {
      if (activeRepairRequestRef.current === requestId) {
        setRepairDetail("停止请求失败，可以再次停止");
        const message = errorMessage(reason);
        setError(message);
        onNotice?.(message);
      }
    }
  };

  useEffect(() => {
    const offPreview = window.paperxcel.knowledgeBase.onMarkdownPreview(
      streamStore.receive,
    );
    const offAgent = window.paperxcel.knowledgeBase.onAgentEvent(
      streamStore.receiveAgent,
    );
    return () => {
      offPreview();
      offAgent();
    };
  }, [streamStore]);

  useEffect(() => {
    setPreview(undefined);
    setError("");
    setRepairing(false);
    setRepairDetail("");
    streamStore.clear(paper.id);
    attemptedRebuildRef.current = false;
    return () => {
      const requestId = activeRepairRequestRef.current;
      activeRepairRequestRef.current = undefined;
      requestSequenceRef.current++;
      streamStore.clear();
      if (requestId) {
        void (
          onCancelRepair
            ? onCancelRepair(requestId)
            : window.paperxcel.knowledgeBase.cancel(requestId)
        ).catch(() => undefined);
      }
    };
  }, [onCancelRepair, paper.id, streamStore]);

  useEffect(() => {
    if (!refreshToken || activeRepairRequestRef.current) return;
    attemptedRebuildRef.current = false;
    setPreview(undefined);
    setError("");
    streamStore.clear(paper.id);
  }, [refreshToken, paper.id, streamStore]);

  useEffect(() => {
    if (
      viewMode === "markdown" &&
      !preview &&
      !attemptedRebuildRef.current &&
      !loading &&
      !repairing &&
      !error
    ) {
      void loadMarkdown();
    }
  }, [error, loadMarkdown, loading, preview, repairing, viewMode]);

  if (viewMode === "pdf") {
    return (
      <PdfViewer
        url={url}
        page={page}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onPageChange={onPageChange}
        onReferenceSelection={onReferenceSelection}
        onTranslateSelection={onTranslateSelection}
      />
    );
  }

  return (
    <section className="paper-markdown-viewer">
      <div className="pdf-toolbar paper-markdown-toolbar">
        <div className="markdown-preview-meta">
          {preview
            ? preview.aiRepaired
              ? `${preview.pageCount} 页 · AI 重建 · ${preview.model || "当前模型"}`
              : `${preview.pageCount} 页 · 尚未生成 Markdown`
            : "从原始 PDF 重建 Markdown"}
          {repairing && repairDetail ? ` · ${repairDetail}` : ""}
        </div>
        <DocumentViewToggle value={viewMode} onChange={setViewMode} />
        <div className="toolbar-group">
          <button
            className={`markdown-ai-repair-button${repairing ? " is-repairing" : ""}`}
            type="button"
            title={
              repairing
                ? "停止当前 Markdown 重建"
                : provider?.hasApiKey
                  ? `使用 ${provider.model} 每 10 页读取原始 PDF 并重建 Markdown`
                  : "请先在模型设置中配置 API Key"
            }
            disabled={!repairing && (loading || !provider?.hasApiKey)}
            onClick={() => void (repairing ? stopRepair() : repairMarkdown())}
          >
            {repairing ? (
              <Square size={13} fill="currentColor" />
            ) : (
              <Sparkles size={15} />
            )}
            <span>{repairing ? "停止重建" : "重建 Markdown"}</span>
          </button>
          <button
            className="icon-button"
            type="button"
            title="重新读取 Markdown 预览"
            disabled={loading || repairing}
            onClick={() => void loadMarkdown()}
          >
            {loading ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <RefreshCw size={16} />
            )}
          </button>
        </div>
      </div>

      <div className="paper-markdown-stage">
        {loading && !preview && (
          <p className="paper-text-loading" role="status">
            正在读取 Markdown…
          </p>
        )}
        <PaperRepairStreamView
          store={streamStore}
          paperId={paper.id}
          preview={preview}
          error={error}
          onRetry={
            !repairing && provider?.hasApiKey
              ? () => void repairMarkdown("retry")
              : undefined
          }
          onReload={() => void loadMarkdown()}
        />
      </div>
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
