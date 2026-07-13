import { ArrowUpRight, FileSearch, LoaderCircle, Search } from "lucide-react";
import { useMemo } from "react";
import type { LibrarySearchHit, Paper } from "../../shared/contracts";

interface LibrarySearchWorkspaceProps {
  papers: Paper[];
  query: string;
  results: LibrarySearchHit[];
  searching: boolean;
  searched: boolean;
  onQueryChange: (query: string) => void;
  onSearch: (query?: string) => void;
  onOpenHit: (paperId: string, page: number) => void;
}

const presets = [
  {
    label: "方法与近似",
    query:
      "Hamiltonian、理论方法、关键近似、basis set、functional 与 electron correlation",
  },
  {
    label: "复现参数",
    query: "计算软件、体系设置、收敛标准、赝势、相对论处理与可复现参数",
  },
  {
    label: "结果与局限",
    query: "主要 observable、关键结果、误差来源、适用范围与研究局限",
  },
];

export function LibrarySearchWorkspace({
  papers,
  query,
  results,
  searching,
  searched,
  onQueryChange,
  onSearch,
  onOpenHit,
}: LibrarySearchWorkspaceProps): React.JSX.Element {
  const readyPapers = useMemo(
    () => papers.filter((paper) => paper.status === "ready"),
    [papers],
  );
  const paperById = useMemo(
    () => new Map(papers.map((paper) => [paper.id, paper])),
    [papers],
  );

  return (
    <section className="library-search-workspace">
      <header className="library-search-header">
        <div className="library-search-heading">
          <span className="library-search-heading-icon">
            <FileSearch size={18} />
          </span>
          <div>
            <h2>全库检索</h2>
            <p>本地混合检索 · {readyPapers.length} 篇已索引</p>
          </div>
        </div>
      </header>

      <form
        className="library-search-controls"
        onSubmit={(event) => {
          event.preventDefault();
          onSearch();
        }}
      >
        <label className="library-search-field">
          <Search size={18} />
          <input
            aria-label="全库检索问题"
            maxLength={500}
            placeholder="检索方法、参数、结果或局限"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <button
            type="submit"
            disabled={!query.trim() || searching || !readyPapers.length}
          >
            {searching ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Search size={16} />
            )}
            {searching ? "检索中" : "检索"}
          </button>
        </label>
        <div className="library-search-presets">
          {presets.map((preset) => (
            <button
              type="button"
              key={preset.label}
              disabled={searching || !readyPapers.length}
              onClick={() => {
                onQueryChange(preset.query);
                onSearch(preset.query);
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </form>

      <div className="library-search-results">
        <header className="library-search-results-header">
          <strong>检索结果</strong>
          <span>{searched ? `${results.length} 条` : "未检索"}</span>
        </header>

        <div className="library-search-result-list">
          {!readyPapers.length ? (
            <div className="library-search-empty">
              <FileSearch size={28} />
              <strong>暂无已索引文献</strong>
            </div>
          ) : searching && !results.length ? (
            <div className="library-search-empty">
              <LoaderCircle className="spin" size={25} />
              <strong>正在检索</strong>
            </div>
          ) : !searched ? (
            <div className="library-search-empty">
              <Search size={28} />
              <strong>尚未检索</strong>
            </div>
          ) : !results.length ? (
            <div className="library-search-empty">
              <FileSearch size={28} />
              <strong>未找到相关内容</strong>
            </div>
          ) : (
            results.map((hit) => {
              const paper = paperById.get(hit.paperId);
              if (!paper) return null;
              return (
                <button
                  className="library-search-hit"
                  type="button"
                  key={`${hit.paperId}-${hit.chunkId}`}
                  title={`打开第 ${hit.page} 页`}
                  onClick={() => onOpenHit(hit.paperId, hit.page)}
                >
                  <span className="library-search-hit-source">
                    <span className="library-search-hit-page">
                      p.{hit.page}
                    </span>
                    <span className="library-search-hit-paper">
                      <strong>{paper.title}</strong>
                      <small>
                        {paper.authors.slice(0, 3).join(", ") || "作者待补全"}
                        {paper.year ? ` · ${paper.year}` : ""}
                      </small>
                    </span>
                    <ArrowUpRight size={16} />
                  </span>
                  <span className="library-search-hit-text">{hit.text}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
