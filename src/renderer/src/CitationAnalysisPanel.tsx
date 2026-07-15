import {
  ArrowRight,
  ChartNetwork,
  Focus,
  GitBranch,
  LoaderCircle,
  Network,
  Route,
  Share2,
  UsersRound,
} from "lucide-react";
import type {
  CitationGraphNode,
  CitationGraphSnapshot,
  CitationNetworkAnalysis,
  CitationNetworkSimilarity,
} from "../../shared/contracts";

interface CitationAnalysisPanelProps {
  analysis?: CitationNetworkAnalysis;
  snapshot: CitationGraphSnapshot;
  loading: boolean;
  selectedPaperCount: number;
  onFocusNodes: (nodeIds: string[]) => void;
  onSelectNode: (nodeId: string) => void;
}

export function CitationAnalysisPanel({
  analysis,
  snapshot,
  loading,
  selectedPaperCount,
  onFocusNodes,
  onSelectNode,
}: CitationAnalysisPanelProps): React.JSX.Element {
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));

  if (loading) {
    return (
      <AnalysisEmpty
        icon={<LoaderCircle className="spin" size={27} />}
        title="正在分析引文网络"
        description="正在计算社区、耦合关系、共被引和研究路径。"
      />
    );
  }
  if (selectedPaperCount === 0) {
    return (
      <AnalysisEmpty
        icon={<ChartNetwork size={34} />}
        title="先选择分析范围"
        description="从左侧勾选需要分析的本地论文。"
      />
    );
  }
  if (!analysis || analysis.metrics.edgeCount === 0) {
    return (
      <AnalysisEmpty
        icon={<Network size={34} />}
        title="当前没有可分析的关系"
        description="先刷新图谱，取得参考文献和引用本文关系。"
      />
    );
  }

  return (
    <div className="citation-analysis-view">
      <div className="citation-analysis-metrics">
        <Metric label="节点" value={analysis.metrics.nodeCount} />
        <Metric label="引用关系" value={analysis.metrics.edgeCount} />
        <Metric label="研究社区" value={analysis.metrics.communityCount} />
        <Metric label="连通分量" value={analysis.metrics.componentCount} />
        <Metric
          label="网络密度"
          value={`${(analysis.metrics.density * 100).toFixed(1)}%`}
        />
      </div>

      <div className="citation-analysis-grid">
        <section className="citation-analysis-section citation-analysis-communities">
          <header>
            <span>
              <UsersRound size={16} />
              研究社区
            </span>
            <small>{analysis.communities.length}</small>
          </header>
          <div>
            {analysis.communities.map((community, index) => (
              <button
                type="button"
                key={community.id}
                onClick={() => onFocusNodes(community.nodeIds)}
              >
                <i className={`community-color community-${(index % 6) + 1}`} />
                <span>
                  <strong>{community.label}</strong>
                  <small>
                    {community.size} 篇 · 本地 {community.libraryCount} ·{" "}
                    {formatYearRange(community.startYear, community.endYear)}
                  </small>
                </span>
                <Focus size={14} />
              </button>
            ))}
          </div>
        </section>

        <section className="citation-analysis-section citation-analysis-bridges">
          <header>
            <span>
              <GitBranch size={16} />
              桥接论文
            </span>
            <small>{analysis.bridges.length}</small>
          </header>
          <div>
            {analysis.bridges.slice(0, 12).map((bridge) => {
              const node = nodeById.get(bridge.nodeId);
              if (!node) return null;
              return (
                <button
                  type="button"
                  key={bridge.nodeId}
                  onClick={() => onSelectNode(bridge.nodeId)}
                >
                  <span>
                    <strong>{node.title}</strong>
                    <small>
                      连接 {bridge.connectedCommunities} 个社区 · 度数{" "}
                      {bridge.degree}
                    </small>
                  </span>
                  <b>{bridge.score}</b>
                </button>
              );
            })}
          </div>
        </section>

        <section className="citation-analysis-section citation-analysis-paths">
          <header>
            <span>
              <Route size={16} />
              关键演进路径
            </span>
            <small>{analysis.keyPaths.length}</small>
          </header>
          <div>
            {analysis.keyPaths.length ? (
              analysis.keyPaths.slice(0, 6).map((path) => (
                <button
                  type="button"
                  key={path.id}
                  onClick={() => onFocusNodes(path.nodeIds)}
                >
                  <span className="citation-analysis-path-years">
                    {formatYearRange(path.startYear, path.endYear)}
                  </span>
                  <span className="citation-analysis-path-chain">
                    {path.nodeIds.map((nodeId, index) => {
                      const node = nodeById.get(nodeId);
                      return (
                        <span key={nodeId}>
                          {index > 0 && <ArrowRight size={12} />}
                          <strong title={node?.title}>
                            {shortTitle(node?.title ?? nodeId)}
                          </strong>
                        </span>
                      );
                    })}
                  </span>
                </button>
              ))
            ) : (
              <EmptyRow text="当前关系中没有带年份的连续引用路径。" />
            )}
          </div>
        </section>

        <section className="citation-analysis-section citation-analysis-similarities">
          <header>
            <span>
              <Share2 size={16} />
              相似关系
            </span>
            <small>
              {analysis.bibliographicCoupling.length +
                analysis.coCitation.length}
            </small>
          </header>
          <div className="citation-analysis-similarity-columns">
            <SimilarityList
              title="文献耦合"
              links={analysis.bibliographicCoupling}
              nodeById={nodeById}
              onFocusNodes={onFocusNodes}
            />
            <SimilarityList
              title="共被引"
              links={analysis.coCitation}
              nodeById={nodeById}
              onFocusNodes={onFocusNodes}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: string | number;
}): React.JSX.Element {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SimilarityList({
  title,
  links,
  nodeById,
  onFocusNodes,
}: {
  title: string;
  links: CitationNetworkSimilarity[];
  nodeById: Map<string, CitationGraphNode>;
  onFocusNodes: (nodeIds: string[]) => void;
}): React.JSX.Element {
  return (
    <div>
      <h3>{title}</h3>
      {links.length ? (
        links.slice(0, 8).map((link) => (
          <button
            type="button"
            key={`${link.source}:${link.target}`}
            onClick={() => onFocusNodes([link.source, link.target])}
          >
            <span>
              <strong>{shortTitle(nodeById.get(link.source)?.title)}</strong>
              <small>{shortTitle(nodeById.get(link.target)?.title)}</small>
            </span>
            <b>{link.sharedCount}</b>
          </button>
        ))
      ) : (
        <EmptyRow text="暂无显著关系" />
      )}
    </div>
  );
}

function EmptyRow({ text }: { text: string }): React.JSX.Element {
  return <p className="citation-analysis-empty-row">{text}</p>;
}

function AnalysisEmpty({
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

function shortTitle(value = ""): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 42 ? `${normalized.slice(0, 41)}…` : normalized;
}

function formatYearRange(start?: number, end?: number): string {
  if (!start && !end) return "年份未知";
  if (start === end || !end) return String(start ?? end);
  return `${start ?? end} - ${end}`;
}
