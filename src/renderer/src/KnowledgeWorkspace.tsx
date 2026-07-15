import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  BookOpen,
  Database,
  Download,
  History,
  LoaderCircle,
  Search,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type {
  KnowledgeBaseRepairProgress,
  LibraryReview,
  Paper,
  ProviderProfile,
} from "../../shared/contracts";
import { normalizeMarkdownMath } from "./markdown";

interface KnowledgeWorkspaceProps {
  papers: Paper[];
  provider?: ProviderProfile;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

export function KnowledgeWorkspace({
  papers,
  provider,
  onError,
  onNotice,
}: KnowledgeWorkspaceProps): React.JSX.Element {
  const readyPapers = useMemo(
    () => papers.filter((paper) => paper.status === "ready"),
    [papers],
  );
  const [reviews, setReviews] = useState<LibraryReview[]>([]);
  const [selectedReviewId, setSelectedReviewId] = useState<string>();
  const [focus, setFocus] = useState("");
  const [generatingReview, setGeneratingReview] = useState(false);
  const [exportingReview, setExportingReview] = useState(false);
  const [exportingKnowledgeBase, setExportingKnowledgeBase] = useState(false);
  const [repairingKnowledgeBase, setRepairingKnowledgeBase] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportWithAi, setExportWithAi] = useState(false);
  const [exportQuery, setExportQuery] = useState("");
  const [exportSelection, setExportSelection] = useState<Set<string>>(
    () => new Set(),
  );
  const [cancellingExport, setCancellingExport] = useState(false);
  const [repairProgress, setRepairProgress] =
    useState<KnowledgeBaseRepairProgress>();
  const activeExportRequestIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    void window.paperxcel.reviews
      .list()
      .then((nextReviews) => {
        if (disposed) return;
        const availableIds = new Set(papers.map((paper) => paper.id));
        const availableReviews = nextReviews.filter((review) =>
          review.paperIds.every((paperId) => availableIds.has(paperId)),
        );
        setReviews(availableReviews);
        setSelectedReviewId((current) =>
          current && availableReviews.some((review) => review.id === current)
            ? current
            : availableReviews[0]?.id,
        );
      })
      .catch((error: unknown) => {
        if (!disposed) onError(errorMessage(error));
      });
    return () => {
      disposed = true;
    };
  }, [onError, papers]);

  useEffect(
    () =>
      window.paperxcel.knowledgeBase.onProgress((progress) => {
        if (
          progress.requestId &&
          progress.requestId !== activeExportRequestIdRef.current
        ) {
          return;
        }
        setRepairProgress(progress);
      }),
    [],
  );

  const selectedReview =
    reviews.find((review) => review.id === selectedReviewId) ?? reviews[0];
  const exportablePapers = readyPapers;
  const visibleExportPapers = useMemo(() => {
    const normalized = exportQuery.trim().toLocaleLowerCase();
    if (!normalized) return exportablePapers;
    return exportablePapers.filter((paper) =>
      [
        paper.title,
        paper.authors.join(" "),
        paper.journal,
        paper.year,
        paper.doi,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalized),
    );
  }, [exportQuery, exportablePapers]);

  const generateReview = async (): Promise<void> => {
    if (generatingReview) return;
    setGeneratingReview(true);
    try {
      const review = await window.paperxcel.reviews.generate({ focus });
      setReviews((current) => [
        review,
        ...current.filter((item) => item.id !== review.id),
      ]);
      setSelectedReviewId(review.id);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setGeneratingReview(false);
    }
  };

  const exportReview = async (): Promise<void> => {
    if (!selectedReview || exportingReview) return;
    setExportingReview(true);
    try {
      if (await window.paperxcel.reviews.exportMarkdown(selectedReview.id)) {
        onNotice("全库综述已导出。");
      }
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setExportingReview(false);
    }
  };

  const removeReview = async (): Promise<void> => {
    if (!selectedReview) return;
    if (!window.confirm("删除这份全库综述？")) return;
    try {
      await window.paperxcel.reviews.remove(selectedReview.id);
      const next = reviews.filter((review) => review.id !== selectedReview.id);
      setReviews(next);
      setSelectedReviewId(next[0]?.id);
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  const openExportDialog = (aiRepair: boolean): void => {
    if (
      exportingKnowledgeBase ||
      repairingKnowledgeBase ||
      !exportablePapers.length
    ) {
      return;
    }
    setExportWithAi(aiRepair && Boolean(provider?.hasApiKey));
    setExportQuery("");
    setExportSelection(new Set(exportablePapers.map((paper) => paper.id)));
    setRepairProgress(undefined);
    setExportDialogOpen(true);
  };

  const toggleExportPaper = (paperId: string): void => {
    setExportSelection((current) => {
      const next = new Set(current);
      if (next.has(paperId)) next.delete(paperId);
      else next.add(paperId);
      return next;
    });
  };

  const exportKnowledgeBase = async (): Promise<void> => {
    if (
      exportingKnowledgeBase ||
      repairingKnowledgeBase ||
      !exportSelection.size
    ) {
      return;
    }
    const selectedPaperIds = exportablePapers
      .filter((paper) => exportSelection.has(paper.id))
      .map((paper) => paper.id);
    if (!selectedPaperIds.length) return;
    const requestId = crypto.randomUUID();
    activeExportRequestIdRef.current = requestId;
    if (exportWithAi) {
      setRepairingKnowledgeBase(true);
      setRepairProgress({
        requestId,
        phase: "preparing",
        completed: 0,
        total: selectedPaperIds.length,
        detail: "正在准备 AI 修复导出",
      });
    } else {
      setExportingKnowledgeBase(true);
      setRepairProgress({
        requestId,
        phase: "preparing",
        completed: 0,
        total: selectedPaperIds.length,
        detail: "正在准备知识库导出",
      });
    }
    try {
      const result = await window.paperxcel.knowledgeBase.export({
        aiRepair: exportWithAi,
        paperIds: selectedPaperIds,
        requestId,
      });
      if (result) {
        if ("cancelled" in result) {
          onNotice("知识库导出已中断，未保留不完整目录。");
          return;
        }
        const validationWarningCount = result.validation.warnings.length;
        if (result.aiRepair) {
          const issuePaperCount = new Set(
            result.repairIssues.map((issue) => issue.paperId),
          ).size;
          onNotice(
            `AI 修复导出完成：${result.repairedPaperCount}/${result.paperCount} 篇产生修正，校对 ${result.repairedCitationNodeCount} 个引文节点${
              issuePaperCount ? `，${issuePaperCount} 篇含警告` : ""
            }${validationWarningCount ? `，校验发现 ${validationWarningCount} 条提示` : ""}。`,
          );
        } else {
          onNotice(
            `知识库已导出：${result.paperCount} 篇论文${
              validationWarningCount
                ? `，校验发现 ${validationWarningCount} 条提示`
                : ""
            }。`,
          );
        }
        setExportDialogOpen(false);
      }
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      activeExportRequestIdRef.current = undefined;
      setExportingKnowledgeBase(false);
      setRepairingKnowledgeBase(false);
      setCancellingExport(false);
      setRepairProgress(undefined);
    }
  };

  const cancelKnowledgeBaseExport = async (): Promise<void> => {
    const requestId = activeExportRequestIdRef.current;
    if (!requestId || cancellingExport) return;
    setCancellingExport(true);
    try {
      await window.paperxcel.knowledgeBase.cancel(requestId);
    } catch (error) {
      setCancellingExport(false);
      onError(errorMessage(error));
    }
  };

  const exportBusy = exportingKnowledgeBase || repairingKnowledgeBase;
  const exportProgressPercent = repairProgress?.total
    ? Math.round(
        (Math.min(repairProgress.completed, repairProgress.total) /
          repairProgress.total) *
          100,
      )
    : 0;

  return (
    <section className="knowledge-workspace">
      <header className="knowledge-header">
        <div className="knowledge-heading">
          <span className="knowledge-heading-icon">
            <Database size={18} />
          </span>
          <div>
            <h2>知识库</h2>
            <p>
              {repairProgress
                ? `${repairProgress.detail} · ${repairProgress.completed}/${repairProgress.total}`
                : `${readyPapers.length} 篇论文 · ${reviews.length} 份综述`}
            </p>
          </div>
        </div>
        <div className="knowledge-header-actions">
          <button
            className="secondary-button knowledge-ai-export-button"
            type="button"
            title="使用当前模型逐篇修复全文和引文元数据后导出"
            disabled={
              exportingKnowledgeBase ||
              repairingKnowledgeBase ||
              !exportablePapers.length ||
              !provider?.hasApiKey
            }
            onClick={() => openExportDialog(true)}
          >
            {repairingKnowledgeBase ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Sparkles size={15} />
            )}
            {repairingKnowledgeBase
              ? `${repairProgress?.completed ?? 0}/${repairProgress?.total ?? exportSelection.size}`
              : "AI 修复导出"}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={
              exportingKnowledgeBase ||
              repairingKnowledgeBase ||
              !exportablePapers.length
            }
            onClick={() => openExportDialog(false)}
          >
            {exportingKnowledgeBase ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Download size={15} />
            )}
            导出知识库
          </button>
        </div>
      </header>

      <div className="knowledge-review-layout">
          <aside className="knowledge-review-history">
            <header>
              <History size={15} />
              <strong>综述历史</strong>
            </header>
            <div>
              {reviews.map((review) => (
                <button
                  className={selectedReview?.id === review.id ? "selected" : ""}
                  type="button"
                  key={review.id}
                  onClick={() => setSelectedReviewId(review.id)}
                >
                  <strong>{review.focus || "综合梳理当前文献库"}</strong>
                  <small>
                    {review.paperIds.length} 篇 · {formatDate(review.createdAt)}
                  </small>
                </button>
              ))}
              {!reviews.length && (
                <div className="knowledge-empty compact">
                  <History size={21} />
                  <strong>暂无综述</strong>
                </div>
              )}
            </div>
          </aside>

          <section className="knowledge-review-main">
            <div className="knowledge-review-controls">
              <input
                value={focus}
                maxLength={500}
                placeholder="研究焦点（可选）"
                onChange={(event) => setFocus(event.target.value)}
              />
              <button
                className="primary-button"
                type="button"
                disabled={
                  !provider?.hasApiKey ||
                  generatingReview ||
                  repairingKnowledgeBase ||
                  !readyPapers.length
                }
                title="生成全库综述"
                onClick={() => void generateReview()}
              >
                {generatingReview ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <Sparkles size={15} />
                )}
                生成综述
              </button>
            </div>

            {selectedReview ? (
              <>
                <header className="knowledge-review-title">
                  <div>
                    <h3>{selectedReview.focus || "综合梳理当前文献库"}</h3>
                    <p>
                      {selectedReview.paperIds.length} 篇 ·{" "}
                      {selectedReview.model} ·{" "}
                      {formatDate(selectedReview.createdAt)}
                    </p>
                  </div>
                  <div>
                    <button
                      className="icon-button"
                      type="button"
                      title="导出 Markdown"
                      disabled={exportingReview}
                      onClick={() => void exportReview()}
                    >
                      {exportingReview ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <Download size={16} />
                      )}
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      title="删除综述"
                      onClick={() => void removeReview()}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </header>
                <article className="knowledge-review-content knowledge-markdown">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
                    rehypePlugins={[rehypeKatex]}
                  >
                    {normalizeMarkdownMath(selectedReview.content)}
                  </ReactMarkdown>
                </article>
              </>
            ) : (
              <div className="knowledge-empty">
                {generatingReview ? (
                  <LoaderCircle className="spin" size={26} />
                ) : (
                  <BookOpen size={27} />
                )}
                <strong>
                  {readyPapers.length
                    ? "尚未生成全库综述"
                    : "暂无可用于综述的论文"}
                </strong>
              </div>
            )}
          </section>
      </div>

      {exportDialogOpen && (
        <div
          className="dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !exportBusy) {
              setExportDialogOpen(false);
            }
          }}
        >
          <section
            className="dialog knowledge-export-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="knowledge-export-title"
          >
            <header className="dialog-header">
              <div>
                <h2 id="knowledge-export-title">导出知识库</h2>
                <p>选择需要交给 Codex 使用的论文</p>
              </div>
              <button
                className="icon-button"
                type="button"
                title="关闭"
                disabled={exportBusy}
                onClick={() => setExportDialogOpen(false)}
              >
                <X size={17} />
              </button>
            </header>

            <div className="knowledge-export-body">
              <div className="knowledge-export-toolbar">
                <label className="knowledge-search">
                  <Search size={15} />
                  <input
                    value={exportQuery}
                    placeholder="搜索待导出论文"
                    disabled={exportBusy}
                    onChange={(event) => setExportQuery(event.target.value)}
                  />
                </label>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={exportBusy}
                  onClick={() => {
                    const allVisibleSelected = visibleExportPapers.every(
                      (paper) => exportSelection.has(paper.id),
                    );
                    setExportSelection((current) => {
                      const next = new Set(current);
                      for (const paper of visibleExportPapers) {
                        if (allVisibleSelected) next.delete(paper.id);
                        else next.add(paper.id);
                      }
                      return next;
                    });
                  }}
                >
                  {visibleExportPapers.every((paper) =>
                    exportSelection.has(paper.id),
                  )
                    ? "取消当前结果"
                    : "选择当前结果"}
                </button>
              </div>

              <label
                className={`knowledge-export-ai-option ${
                  exportWithAi ? "selected" : ""
                }`}
              >
                <input
                  type="checkbox"
                  checked={exportWithAi}
                  disabled={exportBusy || !provider?.hasApiKey}
                  onChange={(event) => setExportWithAi(event.target.checked)}
                />
                <Sparkles size={16} />
                <span>
                  <strong>使用 AI 逐篇修复导出副本</strong>
                  <small>
                    优先复用阅读区的 AI
                    正文缓存，再校对尚未处理的正文和引文元数据
                  </small>
                </span>
              </label>

              <div className="knowledge-export-paper-list">
                {visibleExportPapers.map((paper) => (
                  <label
                    className={exportSelection.has(paper.id) ? "selected" : ""}
                    key={paper.id}
                  >
                    <input
                      type="checkbox"
                      checked={exportSelection.has(paper.id)}
                      disabled={exportBusy}
                      onChange={() => toggleExportPaper(paper.id)}
                    />
                    <span>
                      <strong>{paper.title}</strong>
                      <small>
                        {paper.authors.slice(0, 3).join(", ") || "作者待补全"}
                        {paper.year ? ` · ${paper.year}` : ""}
                        {paper.doi ? ` · ${paper.doi}` : ""}
                      </small>
                    </span>
                  </label>
                ))}
                {!visibleExportPapers.length && (
                  <div className="knowledge-empty compact">
                    <Search size={21} />
                    <strong>没有匹配的论文</strong>
                  </div>
                )}
              </div>

              {exportBusy && repairProgress && (
                <div className="knowledge-export-progress" aria-live="polite">
                  <div>
                    <LoaderCircle className="spin" size={16} />
                    <span>
                      <strong>{repairProgress.detail}</strong>
                      <small>
                        {repairProgress.paperTitle ||
                          `${repairProgress.completed}/${repairProgress.total}`}
                      </small>
                    </span>
                    <b>{exportProgressPercent}%</b>
                  </div>
                  <progress
                    max={Math.max(1, repairProgress.total)}
                    value={repairProgress.completed}
                  />
                </div>
              )}
            </div>

            <footer className="dialog-footer knowledge-export-footer">
              <span>
                已选择 {exportSelection.size}/{exportablePapers.length} 篇
              </span>
              <div>
                {exportBusy ? (
                  <button
                    className="secondary-button danger-button"
                    type="button"
                    disabled={cancellingExport}
                    onClick={() => void cancelKnowledgeBaseExport()}
                  >
                    {cancellingExport ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : (
                      <Square size={13} fill="currentColor" />
                    )}
                    {cancellingExport ? "正在中断" : "中断导出"}
                  </button>
                ) : (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setExportDialogOpen(false)}
                  >
                    取消
                  </button>
                )}
                <button
                  className="primary-button"
                  type="button"
                  disabled={exportBusy || !exportSelection.size}
                  onClick={() => void exportKnowledgeBase()}
                >
                  {exportBusy ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <Download size={15} />
                  )}
                  {exportWithAi ? "AI 修复并导出" : "开始导出"}
                </button>
              </div>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
