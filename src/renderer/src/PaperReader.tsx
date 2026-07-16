import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  CircleAlert,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  Square,
} from "lucide-react";
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
import { normalizeMarkdownMath } from "./markdown";
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
  const [error, setError] = useState("");
  const requestSequenceRef = useRef(0);
  const activeRepairRequestRef = useRef<string | undefined>(undefined);

  const loadMarkdown = useCallback(async (): Promise<void> => {
    const requestSequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestSequence;
    setLoading(true);
    setError("");
    try {
      const next = await window.paperxcel.knowledgeBase.previewMarkdown(
        paper.id,
      );
      if (requestSequence === requestSequenceRef.current) setPreview(next);
    } catch (reason) {
      if (requestSequence === requestSequenceRef.current) {
        setError(errorMessage(reason));
      }
    } finally {
      if (requestSequence === requestSequenceRef.current) setLoading(false);
    }
  }, [paper.id]);

  const repairMarkdown = async (): Promise<void> => {
    if (repairing || !provider?.hasApiKey) return;
    const requestId = crypto.randomUUID();
    activeRepairRequestRef.current = requestId;
    setRepairing(true);
    setRepairDetail("正在准备 PDF 全文修复");
    setError("");
    try {
      const next = onRepairMarkdown
        ? await onRepairMarkdown(paper.id, requestId)
        : await window.paperxcel.knowledgeBase.repairMarkdown(
            paper.id,
            requestId,
          );
      if (activeRepairRequestRef.current !== requestId) return;
      if ("cancelled" in next) {
        onNotice?.("文件修复已停止。");
        return;
      }
      setPreview(next);
      const warningDetails = (next.warnings ?? []).filter(Boolean);
      onNotice?.(
        warningDetails.length
          ? `论文全文已由 ${next.model || provider.model} 修复并缓存。兼容性提示：${warningDetails.join("；")}`
          : `论文全文已由 ${next.model || provider.model} 修复并缓存。`,
      );
    } catch (reason) {
      if (activeRepairRequestRef.current !== requestId) return;
      const message = errorMessage(reason);
      setError(message);
      onNotice?.(message);
    } finally {
      if (activeRepairRequestRef.current === requestId) {
        activeRepairRequestRef.current = undefined;
        setRepairing(false);
        setRepairDetail("");
      }
    }
  };

  const stopRepair = async (): Promise<void> => {
    const requestId = activeRepairRequestRef.current;
    if (!requestId) return;
    setRepairDetail("正在停止文件修复");
    try {
      const stopped = onCancelRepair
        ? await onCancelRepair(requestId)
        : await window.paperxcel.knowledgeBase.cancel(requestId);
      if (!stopped && activeRepairRequestRef.current === requestId) {
        activeRepairRequestRef.current = undefined;
        setRepairing(false);
        setRepairDetail("");
      }
    } catch (reason) {
      if (activeRepairRequestRef.current === requestId) {
        activeRepairRequestRef.current = undefined;
        setRepairing(false);
        setRepairDetail("");
        const message = errorMessage(reason);
        setError(message);
        onNotice?.(message);
      }
    }
  };

  useEffect(
    () =>
      window.paperxcel.knowledgeBase.onProgress((progress) => {
        if (
          progress.requestId &&
          progress.requestId === activeRepairRequestRef.current
        ) {
          setRepairDetail(progress.detail);
        }
      }),
    [],
  );

  useEffect(() => {
    setPreview(undefined);
    setError("");
    setRepairing(false);
    setRepairDetail("");
    return () => {
      const requestId = activeRepairRequestRef.current;
      activeRepairRequestRef.current = undefined;
      if (requestId) {
        void (onCancelRepair
          ? onCancelRepair(requestId)
          : window.paperxcel.knowledgeBase.cancel(requestId));
      }
    };
  }, [onCancelRepair, paper.id]);

  useEffect(() => {
    if (!refreshToken) return;
    setPreview(undefined);
    setError("");
  }, [refreshToken]);

  useEffect(() => {
    if (viewMode === "markdown" && !preview && !loading && !error) {
      void loadMarkdown();
    }
  }, [error, loadMarkdown, loading, preview, viewMode]);

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
              ? `${preview.pageCount} 页 · AI 文件修复 · ${preview.model || "当前模型"}`
              : `${preview.pageCount} 页 · 本地版面重建`
            : "本地版面重建"}
          {repairing && repairDetail ? ` · ${repairDetail}` : ""}
        </div>
        <DocumentViewToggle value={viewMode} onChange={setViewMode} />
        <div className="toolbar-group">
          <button
            className={`markdown-ai-repair-button${repairing ? " is-repairing" : ""}`}
            type="button"
            title={
              repairing
                ? "停止当前文件修复"
                : provider?.hasApiKey
                  ? `使用 ${provider.model} 修复当前论文全文文件`
                  : "请先在模型设置中配置 API Key"
            }
            disabled={loading || (!repairing && !provider?.hasApiKey)}
            onClick={() => void (repairing ? stopRepair() : repairMarkdown())}
          >
            {repairing ? (
              <Square size={13} fill="currentColor" />
            ) : (
              <Sparkles size={15} />
            )}
            <span>{repairing ? "停止修复" : "文件修复"}</span>
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
        {preview?.warnings?.length ? (
          <div className="paper-markdown-warning" role="status">
            <CircleAlert size={16} />
            <div>
              <strong>兼容性提示</strong>
              {preview.warnings.map((warning, index) => (
                <p key={`${index}-${warning}`}>{warning}</p>
              ))}
            </div>
          </div>
        ) : null}
        {loading && !preview ? (
          <div className="paper-markdown-state">
            <LoaderCircle className="spin" size={24} />
            <strong>正在重建 Markdown</strong>
            <span>从本地 PDF 索引恢复页面与段落结构</span>
          </div>
        ) : error && !preview ? (
          <div className="paper-markdown-state error-state">
            <CircleAlert size={24} />
            <strong>Markdown 生成失败</strong>
            <span>{error}</span>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void loadMarkdown()}
            >
              重试
            </button>
          </div>
        ) : preview ? (
          <article className="paper-markdown-document knowledge-markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
              rehypePlugins={[rehypeKatex]}
            >
              {normalizeMarkdownMath(preview.markdown)}
            </ReactMarkdown>
          </article>
        ) : null}
      </div>
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
