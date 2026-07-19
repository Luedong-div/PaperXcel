import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Compass,
  Copy,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileSearch,
  LoaderCircle,
  Quote,
  Search,
  Share2,
} from "lucide-react";
import type {
  CitationDiscoveryMode,
  CitationDiscoveryReason,
  CitationDiscoveryResult,
  CitationGraphNode,
} from "../../shared/contracts";
import { CITATION_DISCOVERY_PAGE_SIZE } from "../../shared/citationDiscovery";

interface CitationDiscoveryPanelProps {
  result?: CitationDiscoveryResult;
  mode?: CitationDiscoveryMode;
  loading: boolean;
  selectedPaperCount: number;
  onOpenDetails: (work: CitationGraphNode) => void;
  onOpenSource: (sourceUrl: string) => void;
  onOpenGoogleScholar: () => void;
}

const reasonLabels: Record<CitationDiscoveryReason, string> = {
  "topic-match": "内容关键词匹配",
  "cites-library": "引用库内论文",
  "shared-references": "共享参考文献",
};

const reasonOrder: CitationDiscoveryReason[] = [
  "shared-references",
  "cites-library",
  "topic-match",
];

type DiscoverySort = "relevance" | "newest";

export function CitationDiscoveryPanel({
  result,
  mode = result?.mode ?? "contextual",
  loading,
  selectedPaperCount,
  onOpenDetails,
  onOpenSource,
  onOpenGoogleScholar,
}: CitationDiscoveryPanelProps): React.JSX.Element {
  const [copiedDoi, setCopiedDoi] = useState<string>();
  const [sort, setSort] = useState<DiscoverySort>("relevance");
  const [page, setPage] = useState(1);

  const sortedCandidates = useMemo(() => {
    if (!result) return [];
    if (sort === "relevance") return result.candidates;
    return [...result.candidates].sort(
      (first, second) =>
        (second.work.year ?? -1) - (first.work.year ?? -1) ||
        second.recencyScore - first.recencyScore ||
        second.score - first.score ||
        (second.work.citedByCount ?? -1) - (first.work.citedByCount ?? -1) ||
        first.work.title.localeCompare(second.work.title),
    );
  }, [result, sort]);

  const totalPages = Math.max(
    1,
    Math.ceil(sortedCandidates.length / CITATION_DISCOVERY_PAGE_SIZE),
  );
  const activePage = Math.min(page, totalPages);
  const visibleCandidates = sortedCandidates.slice(
    (activePage - 1) * CITATION_DISCOVERY_PAGE_SIZE,
    activePage * CITATION_DISCOVERY_PAGE_SIZE,
  );

  useEffect(() => {
    setPage(1);
  }, [mode, result?.searchedAt]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const copyDoi = async (doi: string): Promise<void> => {
    await window.paperxcel.clipboard.writeText(doi);
    setCopiedDoi(doi);
    window.setTimeout(() => setCopiedDoi(undefined), 1400);
  };

  if (loading) {
    return (
      <DiscoveryEmpty
        icon={<LoaderCircle className="spin" size={27} />}
        title="正在发现外部论文"
        description="正在通过开放源检索论文元数据。"
      />
    );
  }
  if (selectedPaperCount === 0 && mode !== "pure-search") {
    return (
      <DiscoveryEmpty
        icon={<Compass size={34} />}
        title="先选择推荐起点"
        description="从左侧勾选一篇或多篇本地论文。"
      />
    );
  }
  if (!result && mode === "pure-search") {
    return (
      <DiscoveryEmpty
        icon={<Search size={32} />}
        title="纯搜索"
        description="输入主题关键词后点击“纯搜索”，通过 OpenAlex、Crossref、Europe PMC 与 arXiv 检索论文。"
        action={<GoogleScholarButton onClick={onOpenGoogleScholar} />}
      />
    );
  }
  if (!result) {
    return (
      <DiscoveryEmpty
        icon={<FileSearch size={34} />}
        title={mode === "pure-search" ? "纯搜索论文" : "发现相关论文"}
        description={
          mode === "pure-search"
            ? "输入主题关键词，空格或英文逗号可以匹配多个关键词。"
            : "输入主题或直接使用当前论文内容生成推荐。"
        }
      />
    );
  }
  if (result.candidates.length === 0) {
    return (
      <DiscoveryEmpty
        icon={<Search size={32} />}
        title="没有找到新的候选论文"
        description="可以更换关键词，或直接打开学术搜索网页继续查找。"
        action={<GoogleScholarButton onClick={onOpenGoogleScholar} />}
      />
    );
  }

  return (
    <div className="citation-discovery-view">
      <header className="citation-research-summary">
        <div>
          <span>外部论文推荐</span>
          <strong>{result.candidates.length} 篇候选</strong>
        </div>
        <div className="citation-discovery-summary-actions">
          <button
            className="citation-discovery-scholar"
            type="button"
            title="在 Google Scholar 网页中继续检索"
            onClick={onOpenGoogleScholar}
          >
            <ExternalLink size={13} />
            Google Scholar
          </button>
          <label className="citation-discovery-sort">
            <span>排序</span>
            <select
              aria-label="发现结果排序"
              value={sort}
              onChange={(event) => {
                setSort(event.target.value as DiscoverySort);
                setPage(1);
              }}
            >
              <option value="relevance">推荐排序</option>
              <option value="newest">时间排序</option>
            </select>
          </label>
          <div className="citation-discovery-terms">
            {result.terms.slice(0, 8).map((term) => (
              <span key={term}>{term}</span>
            ))}
          </div>
        </div>
      </header>

      {result.warnings.length > 0 && (
        <div className="citation-research-warning">
          <span>{result.warnings[0]}</span>
          {result.warnings.length > 1 && (
            <small>另有 {result.warnings.length - 1} 项</small>
          )}
        </div>
      )}

      <div className="citation-discovery-list">
        {visibleCandidates.map((candidate, index) => (
          <article
            className="citation-discovery-result"
            key={candidate.work.id}
            role="button"
            tabIndex={0}
            aria-label={`查看论文详情：${candidate.work.title}`}
            onClick={() => onOpenDetails(candidate.work)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onOpenDetails(candidate.work);
            }}
          >
            <div className="citation-discovery-rank">
              <span>
                {String(
                  (activePage - 1) * CITATION_DISCOVERY_PAGE_SIZE + index + 1,
                ).padStart(2, "0")}
              </span>
              <strong>{candidate.score}</strong>
              <small>推荐分</small>
            </div>
            <div className="citation-discovery-content">
              <div className="citation-discovery-reasons">
                {reasonOrder
                  .filter((reason) => candidate.reasons.includes(reason))
                  .map((reason) => (
                    <span className={reason} key={reason}>
                      {reason === "cites-library" ? (
                        <Quote size={12} />
                      ) : reason === "shared-references" ? (
                        <Share2 size={12} />
                      ) : (
                        <Compass size={12} />
                      )}
                      {reasonLabels[reason]}
                    </span>
                  ))}
              </div>
              <h3>{candidate.work.title}</h3>
              <p className="citation-discovery-authors">
                {candidate.work.authors.slice(0, 5).join(", ") || "作者未知"}
              </p>
              <div className="citation-discovery-meta">
                <span>{candidate.work.year ?? "年份未知"}</span>
                <span>{candidate.work.journal ?? "来源未知"}</span>
                <span>
                  被引{" "}
                  {typeof candidate.work.citedByCount === "number"
                    ? candidate.work.citedByCount.toLocaleString()
                    : "未知"}
                </span>
                {candidate.sharedReferenceCount > 0 && (
                  <span>共享参考 {candidate.sharedReferenceCount}</span>
                )}
              </div>
              {candidate.work.abstract && (
                <p className="citation-discovery-abstract">
                  {candidate.work.abstract}
                </p>
              )}
              <div className="citation-discovery-score">
                <span>
                  内容 <strong>{candidate.relevanceScore}</strong>
                </span>
                <span>
                  影响 <strong>{candidate.citationImpactScore}</strong>
                </span>
                <span>
                  时效 <strong>{candidate.recencyScore}</strong>
                </span>
                <i aria-hidden="true">
                  <i style={{ width: `${candidate.score}%` }} />
                </i>
              </div>
            </div>
            <div className="citation-discovery-actions">
              {candidate.work.doi && (
                <button
                  type="button"
                  title="复制 DOI"
                  onClick={(event) => {
                    event.stopPropagation();
                    void copyDoi(candidate.work.doi!);
                  }}
                >
                  {copiedDoi === candidate.work.doi ? (
                    <Check size={15} />
                  ) : (
                    <Copy size={15} />
                  )}
                </button>
              )}
              {candidate.work.sourceUrl && (
                <button
                  type="button"
                  title="打开论文来源"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenSource(candidate.work.sourceUrl!);
                  }}
                >
                  <ExternalLink size={15} />
                </button>
              )}
            </div>
          </article>
        ))}
      </div>

      {totalPages > 1 && (
        <nav
          className="citation-discovery-pagination"
          aria-label="发现结果分页"
        >
          <button
            type="button"
            aria-label="上一页"
            disabled={activePage === 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            <ChevronLeft size={15} />
          </button>
          <span>
            第 {activePage} / {totalPages} 页
          </span>
          <button
            type="button"
            aria-label="下一页"
            disabled={activePage === totalPages}
            onClick={() =>
              setPage((current) => Math.min(totalPages, current + 1))
            }
          >
            <ChevronRight size={15} />
          </button>
        </nav>
      )}
    </div>
  );
}

function DiscoveryEmpty({
  icon,
  title,
  description,
  action,
}: {
  icon: React.JSX.Element;
  title: string;
  description: string;
  action?: React.JSX.Element;
}): React.JSX.Element {
  return (
    <div className="citation-research-empty">
      {icon}
      <h3>{title}</h3>
      <p>{description}</p>
      {action && (
        <div className="citation-discovery-empty-action">{action}</div>
      )}
    </div>
  );
}

function GoogleScholarButton({
  onClick,
}: {
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      className="citation-discovery-scholar"
      type="button"
      title="在 Google Scholar 网页中搜索"
      onClick={onClick}
    >
      <ExternalLink size={13} />
      Google Scholar
    </button>
  );
}
