import { ChartNetwork, Focus, LoaderCircle, Sparkles } from "lucide-react";
import type { CitationGraphSnapshot } from "../../shared/contracts";
import {
  citationAnalysisSources,
  type CitationAnalysisFinding,
} from "../../shared/citationAnalysisAgent";
import type { CitationAnalysisViewState } from "./useCitationAnalysis";
import { AgentCommentaryView } from "./AgentCommentaryView";
import { AgentExecutionTrace } from "./AgentExecutionTrace";
import { PaperResearchPlanView } from "./PaperResearchPlanView";
import { ChatMarkdown } from "./ChatMarkdown";
import "./citationAnalysis.css";

interface CitationAnalysisPanelProps {
  state: CitationAnalysisViewState;
  snapshot: CitationGraphSnapshot;
  selectedPaperCount: number;
  model?: string;
  question: string;
  onQuestionChange: (question: string) => void;
  onStart: () => void;
  onFocusNodes: (nodeIds: string[]) => void;
  onSelectNode: (nodeId: string) => void;
  conversationControls?: React.ReactNode;
}
const kindLabels: Record<CitationAnalysisFinding["kind"], string> = {
  theme: "研究主题",
  bridge: "关键与桥接工作",
  path: "演进路径",
  gap: "待验证问题",
};

export function CitationAnalysisPanel({
  state,
  snapshot,
  selectedPaperCount,
  model,
  question,
  onQuestionChange,
  onStart,
  onFocusNodes,
  onSelectNode,
  conversationControls,
}: CitationAnalysisPanelProps): React.JSX.Element {
  const running = state.status === "running" || state.status === "stopping";
  const sources = citationAnalysisSources(snapshot);
  const sourceByLabel = new Map(
    sources.map((source) => [source.label, source.node]),
  );
  const sourceById = new Map(sources.map((source) => [source.node.id, source]));
  const coverage = state.research?.coverage;
  const findings = state.research?.findings ?? [];
  const ready = selectedPaperCount > 0 && snapshot.nodes.length > 0;
  const context = state.result?.contextUsage ?? state.progress?.contextUsage;
  return (
    <div className="citation-analysis-view citation-ai-analysis">
      <header className="citation-ai-heading">
        <span className="citation-ai-icon">
          <Sparkles size={23} />
        </span>
        <div>
          <h2>AI 引文网络分析</h2>
          <p>综合文献内容与引用关系，解释主题、关键工作和研究演进。</p>
        </div>
      </header>
      {conversationControls}
      <div className="citation-ai-scope">
        <span>
          完整网络 <strong>{coverage?.total ?? snapshot.nodes.length}</strong>{" "}
          篇
        </span>
        <span>
          提供摘要{" "}
          <strong>
            {coverage?.withAbstract ??
              snapshot.nodes.filter((node) => node.abstract?.trim()).length}
          </strong>{" "}
          篇
        </span>
        <span>
          模型 <strong>{state.result?.model ?? model ?? "未配置"}</strong>
        </span>
      </div>
      <p className="citation-ai-source-note">
        依据完整网络的摘要、关键词和引用关系分析；缺少摘要时会标明证据不足。
      </p>
      <label className="citation-ai-question">
        <span>
          分析关注点 <small>可选</small>
        </span>
        <textarea
          aria-label="分析关注点"
          value={question}
          disabled={running}
          maxLength={6000}
          rows={2}
          placeholder="例如：比较主要研究方法，找出结论分歧，以及值得优先阅读的论文。"
          onChange={(event) => onQuestionChange(event.target.value)}
        />
      </label>
      {state.error && state.status === "idle" && (
        <p className="citation-ai-error" role="alert">
          {state.error}
        </p>
      )}
      {state.status === "idle" && (
        <div className="citation-ai-start">
          <button type="button" disabled={!ready} onClick={onStart}>
            <Sparkles size={16} />
            开始 AI 分析
          </button>
          {!ready && <p>请先在左侧选择论文并加载引文网络。</p>}
        </div>
      )}
      {state.status !== "idle" && (
        <>
          <div
            className={`citation-ai-status is-${state.status}`}
            role="status"
          >
            {running ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <ChartNetwork size={16} />
            )}
            <span>
              {state.status === "completed"
                ? "分析完成"
                : state.status === "cancelled"
                  ? "已停止，保留已生成的内容和发现"
                  : state.status === "interrupted"
                    ? "任务已中断，已恢复保存的内容"
                    : state.status === "failed"
                      ? "分析未完成"
                      : state.status === "stopping"
                        ? "正在停止分析"
                        : state.progress?.detail || "正在启动分析 agent"}
            </span>
            {coverage && (
              <small>
                已读 {coverage.read}/{coverage.total} · 已记录 {coverage.noted}/
                {coverage.total}
              </small>
            )}
          </div>
          {context && (
            <p className="citation-ai-context">
              上下文 {Math.round(context.inputTokens / 1000)}K / 273K
              {context.compactions > 0
                ? ` · 已自动压缩 ${context.compactions} 次`
                : ""}
            </p>
          )}
          {state.error && (
            <p className="citation-ai-error" role="alert">
              {state.error}
            </p>
          )}
          <PaperResearchPlanView events={state.events} />
          <AgentCommentaryView events={state.events} live={running} />
          {state.content && (
            <article
              className="citation-ai-report knowledge-markdown"
              aria-label="AI 分析报告"
              onClick={(event) => {
                const anchor = (event.target as Element).closest("a");
                const match = anchor
                  ?.getAttribute("href")
                  ?.match(/^#citation\/(P\d+)$/);
                if (!match) return;
                event.preventDefault();
                const node = sourceByLabel.get(match[1]);
                if (node) onSelectNode(node.id);
              }}
            >
              <ChatMarkdown content={state.content} />
            </article>
          )}
          {findings.length > 0 && (
            <div className="citation-ai-findings">
              {(
                Object.keys(kindLabels) as CitationAnalysisFinding["kind"][]
              ).map((kind) => {
                const items = findings.filter(
                  (finding) => finding.kind === kind,
                );
                return (
                  items.length > 0 && (
                    <section
                      key={kind}
                      className={`citation-ai-finding-group kind-${kind}`}
                    >
                      <h3>
                        {kindLabels[kind]} <small>{items.length}</small>
                      </h3>
                      {items.map((finding) => (
                        <article
                          key={finding.id}
                          className="citation-ai-finding"
                        >
                          <header>
                            <h4>{finding.title}</h4>
                            {finding.tentative && <small>待验证</small>}
                          </header>
                          <p>{finding.explanation}</p>
                          <div className="citation-ai-evidence">
                            {finding.nodeIds.map((nodeId) => {
                              const source = sourceById.get(nodeId);
                              return (
                                source && (
                                  <button
                                    type="button"
                                    key={nodeId}
                                    title={source.node.title}
                                    onClick={() => onSelectNode(nodeId)}
                                  >
                                    {source.label} · {source.node.title}
                                  </button>
                                )
                              );
                            })}
                          </div>
                          <button
                            type="button"
                            className="citation-ai-focus"
                            onClick={() => onFocusNodes(finding.nodeIds)}
                          >
                            <Focus size={14} />
                            在图谱中查看
                          </button>
                        </article>
                      ))}
                    </section>
                  )
                );
              })}
            </div>
          )}
          <AgentExecutionTrace events={state.events} live={running} />
        </>
      )}
    </div>
  );
}
