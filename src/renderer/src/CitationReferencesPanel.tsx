import { useEffect, useState } from "react";
import { BookOpen, ChevronRight, LoaderCircle, RefreshCw } from "lucide-react";
import type {
  CitationGraphNode,
  CitationReferencesResult,
} from "../../shared/contracts";

export function CitationReferencesPanel({
  selected,
  onSelect,
}: {
  selected: CitationGraphNode;
  onSelect: (node: CitationGraphNode) => void;
}): React.JSX.Element {
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [pages, setPages] = useState<Record<number, CitationReferencesResult>>(
    {},
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const { id, paperId, openAlexId, doi } = selected;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void window.paperxcel.citationGraph
      .references({ nodeId: id, paperId, openAlexId, doi, offset, limit: 50 })
      .then((result) => {
        if (!cancelled)
          setPages((current) => ({ ...current, [offset]: result }));
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, paperId, openAlexId, doi, offset, attempt]);

  const result = pages[offset];
  const items = [
    ...new Map(
      Object.values(pages)
        .flatMap((page) => page.items)
        .map((node) => [node.id, node]),
    ).values(),
  ];
  const warnings = result?.warnings ?? [];
  return (
    <section
      className="citation-references"
      aria-label="参考文件"
      aria-busy={loading}
    >
      <p className="citation-reference-summary">
        本文引用的文献{result ? ` · 已载入 ${items.length} 篇` : ""}
        {result && result.nextOffset !== undefined
          ? ` / ${result.total} 篇`
          : ""}
      </p>
      <div className="citation-related-list citation-reference-list">
        {items.map((node) => (
          <button
            key={node.id}
            type="button"
            onClick={() => onSelect(node)}
            title={`查看 ${node.title}`}
          >
            <BookOpen size={14} />
            <span>
              <strong>{node.title}</strong>
              <small>
                {[node.authors.slice(0, 2).join(", "), node.year, node.journal]
                  .filter(Boolean)
                  .join(" · ") ||
                  node.doi ||
                  node.openAlexId ||
                  "书目信息待补全"}
              </small>
              {node.kind === "library" && <small>已在资料库</small>}
            </span>
            <ChevronRight size={14} />
          </button>
        ))}
      </div>
      {loading && (
        <p className="citation-reference-status" role="status">
          <LoaderCircle className="spin" size={16} />
          正在读取参考文件…
        </p>
      )}
      {!loading && !error && !warnings.length && !items.length && (
        <div className="citation-detail-tab-empty">
          <BookOpen size={20} />
          <p>数据源尚未提供这篇论文的参考文件。</p>
        </div>
      )}
      {(error || warnings.length > 0) && (
        <div
          className="citation-reference-status citation-reference-warning"
          role="status"
        >
          {[error, ...warnings].filter(Boolean).map((message) => (
            <p key={message}>{message}</p>
          ))}
          <button
            className="subtle-button"
            type="button"
            disabled={loading}
            onClick={() => setAttempt((current) => current + 1)}
          >
            <RefreshCw size={14} />
            重试加载
          </button>
        </div>
      )}
      {result?.nextOffset !== undefined && (
        <button
          className="subtle-button citation-reference-more"
          type="button"
          disabled={loading}
          onClick={() => setOffset(result.nextOffset!)}
        >
          加载更多参考文件
        </button>
      )}
    </section>
  );
}
