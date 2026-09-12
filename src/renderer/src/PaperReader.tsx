import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  Check,
  CircleAlert,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  Square,
  Undo2,
} from "lucide-react";
import type {
  AgentEvent,
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
  const [restoring, setRestoring] = useState(false);
  const [repairDetail, setRepairDetail] = useState("");
  const [repairAgentEvents, setRepairAgentEvents] = useState<AgentEvent[]>([]);
  const [error, setError] = useState("");
  const [markdownVersion, setMarkdownVersion] = useState<"ai" | "original">(
    "ai",
  );
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
        markdownVersion,
      );
      if (requestSequence === requestSequenceRef.current) {
        setPreview(next);
        setMarkdownVersion(next.aiRepaired ? "ai" : "original");
      }
    } catch (reason) {
      if (requestSequence === requestSequenceRef.current) {
        setError(errorMessage(reason));
      }
    } finally {
      if (requestSequence === requestSequenceRef.current) setLoading(false);
    }
  }, [markdownVersion, paper.id]);

  const repairMarkdown = async (): Promise<void> => {
    if (repairing || !provider?.hasApiKey) return;
    const requestId = crypto.randomUUID();
    activeRepairRequestRef.current = requestId;
    setRepairing(true);
    setPreview(undefined);
    setLoading(true);
    setRepairDetail("正在准备 PDF 全文修复");
    setRepairAgentEvents([]);
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
      setMarkdownVersion("ai");
      onNotice?.(`论文全文已由 ${next.model || provider.model} 修复并缓存。`);
    } catch (reason) {
      if (activeRepairRequestRef.current !== requestId) return;
      const message = errorMessage(reason);
      setError(message);
      onNotice?.(message);
    } finally {
      if (activeRepairRequestRef.current === requestId) {
        activeRepairRequestRef.current = undefined;
        setRepairing(false);
        setLoading(false);
        setRepairDetail("");
        setRepairAgentEvents([]);
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

  const switchMarkdownVersion = async (): Promise<void> => {
    if (repairing || restoring || !preview) return;
    setRestoring(true);
    setError("");
    try {
      const targetVersion = preview.aiRepaired ? "original" : "ai";
      const next = await window.paperxcel.knowledgeBase.previewMarkdown(
        paper.id,
        targetVersion,
      );
      setPreview(next);
      setMarkdownVersion(targetVersion);
      onNotice?.(
        targetVersion === "original"
          ? "已切换到 PDF.js 原始 Markdown，AI 修复缓存仍然保留。"
          : "已切换到 AI 修复 Markdown。",
      );
    } catch (reason) {
      const message = errorMessage(reason);
      setError(message);
      onNotice?.(message);
    } finally {
      setRestoring(false);
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

  useEffect(
    () =>
      window.paperxcel.knowledgeBase.onAgentEvent((event) => {
        if (event.requestId !== activeRepairRequestRef.current) return;
        setRepairAgentEvents((current) => [...current, event].slice(-12));
      }),
    [],
  );

  useEffect(() => {
    const subscribe = window.paperxcel.knowledgeBase.onMarkdownPreview;
    if (!subscribe) return;
    return subscribe((event) => {
      if (event.requestId !== activeRepairRequestRef.current) return;
      setPreview((current) => ({
        ...(current ?? {
          paperId: paper.id,
          pageCount: paper.pageCount ?? 0,
          generatedAt: event.generatedAt,
          aiRepaired: true,
        }),
        markdown: event.content,
        generatedAt: event.generatedAt,
        aiRepaired: true,
        model: provider?.model,
      }));
      setRepairDetail(
        event.done
          ? "Markdown 已生成，正在写入正式缓存"
          : `正在接收 Markdown · ${event.characters.toLocaleString()} 字符`,
      );
    });
  }, [paper.id, paper.pageCount, provider?.model]);

  useEffect(() => {
    setPreview(undefined);
    setError("");
    setRepairing(false);
    setRepairDetail("");
    setRepairAgentEvents([]);
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
          {preview?.hasAiRepairedVersion ? (
            <button
              className="secondary-button markdown-restore-button"
              type="button"
              title={
                preview.aiRepaired
                  ? "切换到 PDF.js 原始 Markdown"
                  : "切换到 AI 修复 Markdown"
              }
              disabled={loading || repairing || restoring}
              onClick={() => void switchMarkdownVersion()}
            >
              {restoring ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <Undo2 size={14} />
              )}
              <span>{restoring ? "切换中" : "切换版本"}</span>
            </button>
          ) : null}
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
        {repairAgentEvents.length ? (
          <div
            className="paper-markdown-agent-timeline"
            aria-label="Markdown 修复 Agent 执行过程"
          >
            <strong>修复 Agent</strong>
            {repairAgentEvents.map((event) => (
              <div
                className={`note-agent-event ${event.status ?? "running"}`}
                key={`${event.sequence}-${event.type}`}
              >
                {event.status === "running" ? (
                  <LoaderCircle className="spin" size={13} />
                ) : event.status === "failed" ? (
                  <CircleAlert size={13} />
                ) : (
                  <Check size={13} />
                )}
                <span>
                  <strong>{event.title}</strong>
                  {event.detail ? <small>{event.detail}</small> : null}
                </span>
              </div>
            ))}
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
            {repairing && preview.aiRepaired ? (
              <div className="paper-markdown-streaming" role="status">
                <LoaderCircle className="spin" size={14} />
                <span>实时预览（尚未写入正式缓存）</span>
              </div>
            ) : null}
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
              rehypePlugins={[rehypeKatex, rehypeRaw]}
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
