import {
  ArrowRightFromLine,
  ArrowRightToLine,
  Check,
  Copy,
  FileText,
} from "lucide-react";
import type {
  CitationGraphNode,
  CitationMatchStatus,
  CitationMetadataSource,
} from "../../shared/contracts";

export function DetailTabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      className={active ? "active" : ""}
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function DetailOverview({
  selected,
  copied,
  onCopyDoi,
}: {
  selected: CitationGraphNode;
  copied: boolean;
  onCopyDoi: () => void;
}): React.JSX.Element {
  return (
    <>
      <dl className="citation-detail-metadata">
        <div>
          <dt>年份</dt>
          <dd>{selected.year ?? "未知"}</dd>
        </div>
        <div>
          <dt>期刊</dt>
          <dd>{selected.journal ?? "未知"}</dd>
        </div>
        {(selected.volume || selected.issue || selected.pages) && (
          <div>
            <dt>卷期页</dt>
            <dd>
              {[
                selected.volume ? `卷 ${selected.volume}` : undefined,
                selected.issue ? `期 ${selected.issue}` : undefined,
                selected.pages ? `页 ${selected.pages}` : undefined,
              ]
                .filter(Boolean)
                .join(" · ")}
            </dd>
          </div>
        )}
        {selected.issn && selected.issn.length > 0 && (
          <div>
            <dt>ISSN</dt>
            <dd>{selected.issn.join(" / ")}</dd>
          </div>
        )}
        <div>
          <dt>被引次数</dt>
          <dd>{formatCitedByCount(selected.citedByCount)}</dd>
        </div>
        {selected.depth !== undefined && (
          <div>
            <dt>图谱层级</dt>
            <dd>{formatCitationGraphLayer(selected)}</dd>
          </div>
        )}
        {selected.parentIds && selected.parentIds.length > 0 && (
          <div>
            <dt>关系路径</dt>
            <dd>
              {selected.direction === "both"
                ? "同时存在参考文献与后续引用路径"
                : selected.depth === 2
                  ? selected.direction === "references"
                    ? "当前参考论文 → 一阶参考 → 目标论文"
                    : "目标论文 → 一阶后续引用 → 当前论文"
                  : selected.direction === "references"
                    ? "当前参考论文 → 目标论文"
                    : selected.direction === "citing"
                      ? "目标论文 → 当前论文"
                      : "当前目标论文"}
            </dd>
          </div>
        )}
        {selected.openAlexId && (
          <div>
            <dt>OpenAlex</dt>
            <dd>{selected.openAlexId}</dd>
          </div>
        )}
        {selected.matchStatus && (
          <div>
            <dt>匹配状态</dt>
            <dd>
              <span className={`citation-match-state ${selected.matchStatus}`}>
                {formatMatchStatus(selected.matchStatus)}
              </span>
            </dd>
          </div>
        )}
        {typeof selected.matchConfidence === "number" && (
          <div>
            <dt>匹配置信度</dt>
            <dd>{Math.round(selected.matchConfidence)}%</dd>
          </div>
        )}
        {selected.metadataSources && selected.metadataSources.length > 0 && (
          <div>
            <dt>元数据来源</dt>
            <dd>{formatMetadataSources(selected.metadataSources)}</dd>
          </div>
        )}
        {selected.textQuality === "degraded" && (
          <div>
            <dt>PDF 文本</dt>
            <dd>存在乱码；匹配时未依赖缺失字符</dd>
          </div>
        )}
      </dl>
      {selected.rawCitation && (
        <article className="citation-raw-reference">
          <span>PDF 原始书目</span>
          <p>{selected.rawCitation}</p>
        </article>
      )}
      {selected.doi && (
        <button
          className="citation-detail-doi"
          type="button"
          title="复制 DOI"
          onClick={onCopyDoi}
        >
          <span>
            <small>DOI</small>
            {selected.doi}
          </span>
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button>
      )}
      <div className="citation-detail-relation-pills">
        {selected.referencedByLibrary && (
          <span className="reference">
            <ArrowRightToLine size={13} />
            被库内论文参考
          </span>
        )}
        {selected.citesLibrary && (
          <span className="citing">
            <ArrowRightFromLine size={13} />
            引用库内论文
          </span>
        )}
      </div>
    </>
  );
}

export function DetailTextState({
  title,
  content,
  empty,
}: {
  title: string;
  content?: string;
  empty: string;
}): React.JSX.Element {
  return content?.trim() ? (
    <article className="citation-detail-prose">
      <span>{title}</span>
      <p>{content}</p>
    </article>
  ) : (
    <div className="citation-detail-tab-empty">
      <FileText size={20} />
      <p>{empty}</p>
    </div>
  );
}

export function formatCitedByCount(value?: number): string {
  return typeof value === "number" ? value.toLocaleString() : "未知";
}

function formatCitationGraphLayer(node: CitationGraphNode): string {
  if (node.depth === 0 || node.direction === "root") return "目标论文";
  if (node.depth === 1 && node.direction === "references") return "一阶参考";
  if (node.depth === 2 && node.direction === "references") return "二阶参考";
  if (node.depth === 1 && node.direction === "citing") return "一阶引用";
  if (node.depth === 2 && node.direction === "citing") return "二阶引用";
  return "双向关联";
}

function formatMatchStatus(status: CitationMatchStatus): string {
  const labels: Record<CitationMatchStatus, string> = {
    verified: "已确认",
    probable: "可能匹配",
    ambiguous: "匹配存疑",
    unresolved: "未解析",
  };
  return labels[status];
}

function formatMetadataSources(sources: CitationMetadataSource[]): string {
  const labels: Record<CitationMetadataSource, string> = {
    library: "文献库",
    pdf: "PDF",
    crossref: "Crossref",
    openalex: "OpenAlex",
    "europe-pmc": "Europe PMC",
    arxiv: "arXiv",
    "google-scholar": "Google Scholar",
    "ai-assisted": "AI 辅助",
  };
  return [...new Set(sources)].map((source) => labels[source]).join(" / ");
}
