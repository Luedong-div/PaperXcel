import { useEffect, useState } from "react";
import {
  Check,
  Compass,
  Copy,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileSearch,
  LoaderCircle,
  Plus,
  Square,
  AlertCircle,
} from "lucide-react";
import type {
  CitationDiscoveryFilters,
  CitationDiscoveryMode,
  CitationDiscoveryResult,
  CitationGraphNode,
  CitationSearchSort,
  CitationSearchSource,
} from "../../shared/contracts";
import { CITATION_DISCOVERY_PAGE_SIZE } from "../../shared/citationDiscovery";
import { normalizeCitationDoi } from "../../shared/citationGraph";

interface CitationDiscoveryPanelProps {
  result?: CitationDiscoveryResult;
  mode?: CitationDiscoveryMode;
  loading: boolean;
  selectedPaperCount: number;
  onOpenDetails: (work: CitationGraphNode) => void;
  onOpenSource: (sourceUrl: string) => void;
  onLoadMore?: (amount: 50 | 100) => void;
  resultLimit?: number;
  maxResultLimit?: number;
  filters?: CitationDiscoveryFilters;
  onFiltersChange?: (filters: CitationDiscoveryFilters) => void;
  filtersDirty?: boolean;
  onApplyFilters?: () => void;
  onStop?: () => void;
  onAddToLibrary?: (work: CitationGraphNode) => Promise<void>;
  libraryDois?: ReadonlySet<string>;
  agentPanel?: React.ReactNode;
}
const SOURCES: Array<{ id: CitationSearchSource; label: string }> = [
  { id: "openalex", label: "OpenAlex" },
  { id: "crossref", label: "Crossref" },
  { id: "europe-pmc", label: "Europe PMC" },
];
const sourceNames: Record<string, string> = Object.fromEntries([
  ...SOURCES.map((source) => [source.id, source.label]),
  ["google-scholar", "Google Scholar"],
]);

export function CitationDiscoveryPanel({
  result,
  mode = result?.mode ?? "contextual",
  loading,
  selectedPaperCount,
  onOpenDetails,
  onOpenSource,
  onLoadMore,
  resultLimit,
  maxResultLimit,
  filters,
  onFiltersChange,
  filtersDirty,
  onApplyFilters,
  onStop,
  onAddToLibrary,
  libraryDois,
  agentPanel,
}: CitationDiscoveryPanelProps): React.JSX.Element {
  const [copiedDoi, setCopiedDoi] = useState<string>();
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState<string>();
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string>();
  const candidates = result?.candidates ?? [];
  const totalPages = Math.max(
    1,
    Math.ceil(candidates.length / CITATION_DISCOVERY_PAGE_SIZE),
  );
  const activePage = Math.min(page, totalPages);
  const visibleCandidates = candidates.slice(
    (activePage - 1) * CITATION_DISCOVERY_PAGE_SIZE,
    activePage * CITATION_DISCOVERY_PAGE_SIZE,
  );
  useEffect(() => {
    setPage(1);
  }, [mode, result?.searchedAt]);
  const copyDoi = async (doi: string): Promise<void> => {
    try {
      await window.paperxcel.clipboard.writeText(doi);
      setCopiedDoi(doi);
    } catch (error) {
      setActionError(String(error));
    }
  };
  const add = async (work: CitationGraphNode): Promise<void> => {
    if (!onAddToLibrary || !work.doi || adding) return;
    setAdding(work.id);
    setActionError(undefined);
    try {
      await onAddToLibrary(work);
      setAdded(
        (current) => new Set([...current, normalizeCitationDoi(work.doi)!]),
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setAdding(undefined);
    }
  };
  const updateFilters = (next: Partial<CitationDiscoveryFilters>): void =>
    onFiltersChange?.({ ...filters, ...next });
  const canLoad =
    !loading &&
    !filtersDirty &&
    result?.hasMore !== false &&
    (resultLimit ?? 0) < (maxResultLimit ?? Infinity);

  return (
    <div className="paper-discovery">
      <header className="paper-discovery-heading">
        <div>
          <h2>{mode === "pure-search" ? "搜索研究文献" : "发现相关论文"}</h2>
          <p>
            {mode === "pure-search"
              ? "从研究问题、论文标题或 DOI 开始"
              : `围绕 ${selectedPaperCount} 篇已选论文，寻找相关研究和后续进展`}
          </p>
        </div>
        {loading && onStop && (
          <button className="paper-action" onClick={onStop} type="button">
            <Square size={12} />
            {mode === "contextual" ? "停止发现" : "停止搜索"}
          </button>
        )}
      </header>
      {agentPanel}
      {filters && (
        <form
          className="paper-search-filters"
          onSubmit={(event) => {
            event.preventDefault();
            onApplyFilters?.();
          }}
        >
          <div className="paper-search-sources" aria-label="搜索来源">
            {SOURCES.map((source) => (
              <label key={source.id}>
                <input
                  type="checkbox"
                  checked={
                    !filters.sources || filters.sources.includes(source.id)
                  }
                  onChange={(event) => {
                    const current =
                      filters.sources ?? SOURCES.map((entry) => entry.id);
                    updateFilters({
                      sources: event.target.checked
                        ? [...current, source.id]
                        : current.filter((entry) => entry !== source.id),
                    });
                  }}
                />
                {source.label}
              </label>
            ))}
          </div>
          <div className="paper-search-years">
            <span>年份</span>
            <input
              aria-label="论文起始年份"
              type="number"
              min={1500}
              max={2100}
              placeholder="不限"
              value={filters.yearFrom ?? ""}
              onChange={(event) =>
                updateFilters({
                  yearFrom: event.target.value
                    ? Number(event.target.value)
                    : undefined,
                })
              }
            />
            <span>—</span>
            <input
              aria-label="论文结束年份"
              type="number"
              min={1500}
              max={2100}
              placeholder="不限"
              value={filters.yearTo ?? ""}
              onChange={(event) =>
                updateFilters({
                  yearTo: event.target.value
                    ? Number(event.target.value)
                    : undefined,
                })
              }
            />
          </div>
          <select
            aria-label="论文检索排序"
            value={filters.sort ?? "relevance"}
            onChange={(event) =>
              updateFilters({ sort: event.target.value as CitationSearchSort })
            }
          >
            <option value="relevance">相关性优先</option>
            <option value="newest">最新发表优先</option>
            <option value="citations">被引次数优先</option>
          </select>
          <button type="submit" disabled={loading}>
            {mode === "contextual"
              ? "按当前条件发现"
              : filtersDirty
                ? "应用筛选并搜索"
                : "搜索"}
          </button>
        </form>
      )}
      {result?.sources && (
        <div className="paper-source-progress" aria-live="polite">
          {result.sources.map((source) => (
            <span
              key={source.id}
              className={source.status}
              title={source.error}
            >
              {source.status === "searching" ? (
                <LoaderCircle size={12} className="spin" />
              ) : source.status === "error" ? (
                <AlertCircle size={12} />
              ) : source.status === "complete" ? (
                <Check size={12} />
              ) : (
                <span>·</span>
              )}
              {source.label} · {source.count} 条
              {source.status === "error" ? " · 暂不可用" : ""}
            </span>
          ))}
          {result.cancelled && <span>已停止，保留已找到的论文</span>}
        </div>
      )}
      {result?.originalQuery && result.query !== result.originalQuery && (
        <p className="paper-query-translation">实际检索：{result.query}</p>
      )}
      {!!result?.warnings.length && (
        <details
          className="paper-search-warnings"
          open={!result.candidates.length}
        >
          <summary>
            {result.warnings.length} 条检索提示
            {result.candidates.length ? " · 已保留可用结果" : ""}
          </summary>
          {result.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </details>
      )}
      {actionError && (
        <p className="paper-search-warnings" role="alert">
          {actionError}
        </p>
      )}
      {!visibleCandidates.length ? (
        <div className="paper-search-empty">
          {loading ? (
            <LoaderCircle size={32} className="spin" />
          ) : mode === "contextual" ? (
            <Compass size={32} />
          ) : (
            <FileSearch size={32} />
          )}
          <h3>
            {loading
              ? "正在检索论文"
              : !result
                ? mode === "contextual" && !selectedPaperCount
                  ? "先选择推荐起点"
                  : "从一个研究问题开始"
                : "没有找到符合条件的论文"}
          </h3>
          <p>
            {loading
              ? "各来源的结果会陆续显示，可随时停止。"
              : !result
                ? mode === "contextual"
                  ? "选择本地论文，输入关注的方向，或直接点击“发现论文”。"
                  : "例如：纳米限域水中的质子传输。也可以粘贴完整标题或 DOI。"
                : "尝试更具体的关键词、放宽年份范围，或查看上方的来源状态。"}
          </p>
        </div>
      ) : (
        <div className="paper-search-results">
          {visibleCandidates.map((candidate, index) => {
            const work = candidate.work;
            const doi = normalizeCitationDoi(work.doi);
            const inLibrary = Boolean(
              doi && (libraryDois?.has(doi) || added.has(doi)),
            );
            return (
              <article className="paper-result" key={work.id}>
                <div className="paper-result-head">
                  <span className="paper-result-number">
                    {String(
                      (activePage - 1) * CITATION_DISCOVERY_PAGE_SIZE +
                        index +
                        1,
                    ).padStart(2, "0")}
                  </span>
                  <button
                    className="paper-result-title"
                    aria-label={`查看论文详情：${work.title}`}
                    type="button"
                    onClick={() => onOpenDetails(work)}
                  >
                    {work.title}
                  </button>
                </div>
                <div className="paper-result-body">
                  <p className="paper-result-authors">
                    {work.authors.slice(0, 5).join(", ") || "作者未知"}
                  </p>
                  <div className="paper-result-meta">
                    <span>{work.year ?? "年份未知"}</span>
                    <span>{work.journal ?? "期刊信息待补充"}</span>
                    <span>
                      被引 {work.citedByCount?.toLocaleString() ?? "未知"}
                    </span>
                    <span>
                      {(work.metadataSources ?? [])
                        .map((source) => sourceNames[source])
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    {inLibrary && <span>已在资料库</span>}
                  </div>
                  {work.abstract && (
                    <p className="paper-result-abstract">{work.abstract}</p>
                  )}
                  {candidate.aiRecommendation && (
                    <div className="paper-ai-recommendation">
                      <p>
                        <strong>推荐理由</strong>{" "}
                        {candidate.aiRecommendation.reason}
                      </p>
                      {candidate.aiRecommendation.evidence.map(
                        (evidence, index) => (
                          <p key={index}>
                            <span>
                              《{evidence.paperTitle}》PDF · 第{" "}
                              {evidence.pages.join("、")} 页
                            </span>{" "}
                            {evidence.connection}
                          </p>
                        ),
                      )}
                      {candidate.aiRecommendation.caveat && (
                        <small>
                          证据局限：{candidate.aiRecommendation.caveat}
                        </small>
                      )}
                    </div>
                  )}
                  <div className="paper-result-bottom">
                    <div className="paper-result-reasons">
                      {candidate.reasons.includes("cites-library") && (
                        <span>引用已选论文</span>
                      )}
                      {candidate.sharedReferenceCount > 0 && (
                        <span>
                          共享 {candidate.sharedReferenceCount} 篇参考文献
                        </span>
                      )}
                      {candidate.relevanceScore > 0 && <span>主题相关</span>}
                      {!work.abstract && <span>摘要暂不可用</span>}
                    </div>
                    <div className="paper-result-actions">
                      {work.doi && (
                        <button
                          className="paper-action"
                          type="button"
                          title="复制 DOI"
                          onClick={() => void copyDoi(work.doi!)}
                        >
                          {copiedDoi === work.doi ? (
                            <Check size={12} />
                          ) : (
                            <Copy size={12} />
                          )}
                          DOI
                        </button>
                      )}
                      {work.sourceUrl && (
                        <button
                          className="paper-action"
                          type="button"
                          onClick={() => onOpenSource(work.sourceUrl!)}
                        >
                          <ExternalLink size={12} />
                          来源
                        </button>
                      )}
                      {onAddToLibrary && work.doi && (
                        <button
                          className="paper-action"
                          type="button"
                          disabled={Boolean(adding) || inLibrary}
                          onClick={() => void add(work)}
                        >
                          {adding === work.id ? (
                            <LoaderCircle className="spin" size={12} />
                          ) : inLibrary ? (
                            <Check size={12} />
                          ) : (
                            <Plus size={12} />
                          )}
                          {inLibrary ? "已入库" : "加入资料库"}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {totalPages > 1 && (
        <nav
          className="citation-discovery-pagination"
          aria-label="发现结果分页"
        >
          <button
            type="button"
            aria-label="上一页"
            disabled={activePage === 1}
            onClick={() => setPage(activePage - 1)}
          >
            <ChevronLeft size={14} />
          </button>
          <span>
            第 {activePage} / {totalPages} 页
          </span>
          <button
            type="button"
            aria-label="下一页"
            disabled={activePage === totalPages}
            onClick={() => setPage(activePage + 1)}
          >
            <ChevronRight size={14} />
          </button>
        </nav>
      )}
      {result && onLoadMore && (
        <div className="paper-search-load">
          <span>当前上限 {resultLimit ?? result.candidates.length}</span>
          {result.hasMore === false ? (
            <span>本次检索已完成</span>
          ) : (
            <>
              <button
                type="button"
                className="paper-action"
                disabled={!canLoad}
                onClick={() => onLoadMore(50)}
              >
                +50
              </button>
              <button
                type="button"
                className="paper-action"
                disabled={!canLoad}
                onClick={() => onLoadMore(100)}
              >
                +100
              </button>
            </>
          )}
          {filtersDirty && <span>条件已修改，请先应用筛选</span>}
        </div>
      )}
    </div>
  );
}
