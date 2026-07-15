import { useState } from "react";
import {
  Check,
  Compass,
  Copy,
  ExternalLink,
  FileSearch,
  LoaderCircle,
  Quote,
  Search,
  Share2,
} from "lucide-react";
import type {
  CitationDiscoveryReason,
  CitationDiscoveryResult,
  CitationGraphNode,
} from "../../shared/contracts";

interface CitationDiscoveryPanelProps {
  result?: CitationDiscoveryResult;
  loading: boolean;
  selectedPaperCount: number;
  onOpenDetails: (work: CitationGraphNode) => void;
  onOpenSource: (sourceUrl: string) => void;
}

const reasonLabels: Record<CitationDiscoveryReason, string> = {
  "topic-match": "内容关键词匹配",
  "cites-library": "引用库内论文",
  "shared-references": "共享参考文献",
};

export function CitationDiscoveryPanel({
  result,
  loading,
  selectedPaperCount,
  onOpenDetails,
  onOpenSource,
}: CitationDiscoveryPanelProps): React.JSX.Element {
  const [copiedDoi, setCopiedDoi] = useState<string>();

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
        description="正在合并内容关键词检索、正向引用和共享参考文献信号。"
      />
    );
  }
  if (selectedPaperCount === 0) {
    return (
      <DiscoveryEmpty
        icon={<Compass size={34} />}
        title="先选择推荐起点"
        description="从左侧勾选一篇或多篇本地论文。"
      />
    );
  }
  if (!result) {
    return (
      <DiscoveryEmpty
        icon={<FileSearch size={34} />}
        title="发现相关论文"
        description="输入主题或直接使用当前论文内容生成推荐。"
      />
    );
  }
  if (result.candidates.length === 0) {
    return (
      <DiscoveryEmpty
        icon={<Search size={32} />}
        title="没有找到新的候选论文"
        description="可以更换关键词，或刷新图谱后再进行推荐。"
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
        <div className="citation-discovery-terms">
          {result.terms.slice(0, 8).map((term) => (
            <span key={term}>{term}</span>
          ))}
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
        {result.candidates.map((candidate, index) => (
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
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{candidate.score}</strong>
              <small>推荐分</small>
            </div>
            <div className="citation-discovery-content">
              <div className="citation-discovery-reasons">
                {candidate.reasons.map((reason) => (
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
    </div>
  );
}

function DiscoveryEmpty({
  icon,
  title,
  description,
}: {
  icon: React.JSX.Element;
  title: string;
  description: string;
}): React.JSX.Element {
  return (
    <div className="citation-research-empty">
      {icon}
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
