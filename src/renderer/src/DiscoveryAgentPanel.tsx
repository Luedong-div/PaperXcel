import { LoaderCircle, Sparkles } from "lucide-react";
import { AgentCommentaryView } from "./AgentCommentaryView";
import { AgentExecutionTrace } from "./AgentExecutionTrace";
import { PaperResearchPlanView } from "./PaperResearchPlanView";
import { ChatMarkdown } from "./ChatMarkdown";
import type { ResearchViewState } from "./useResearchConversation";
import type { CitationGraphNode } from "../../shared/contracts";
import "./citationAnalysis.css";

export function DiscoveryAgentPanel({
  state,
  controls,
  onSelect,
}: {
  state: ResearchViewState;
  controls: React.ReactNode;
  onSelect: (node: CitationGraphNode) => void;
}) {
  const running = state.status === "running" || state.status === "stopping";
  return (
    <section className="discovery-agent-panel" aria-label="AI 论文发现过程">
      {controls}
      {state.status === "idle" ? (
        <p className="citation-ai-source-note">
          点击「发现论文」，AI 会阅读所选论文的本地
          PDF，自主制定查询并挑选相关研究。可在上方输入希望探索的方向。
        </p>
      ) : (
        <>
          <div
            className={`citation-ai-status is-${state.status}`}
            role="status"
          >
            {running ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Sparkles size={15} />
            )}
            <span>
              {state.status === "completed"
                ? "论文发现完成"
                : state.status === "failed"
                  ? "发现未完成，已保留已有内容"
                  : state.status === "cancelled"
                    ? "已停止，保留检索与推荐结果"
                    : state.status === "interrupted"
                      ? "任务已中断，已恢复保存内容"
                      : state.status === "stopping"
                        ? "正在停止"
                        : state.progress?.detail || "正在启动发现 agent"}
            </span>
          </div>
          {state.discovery && (
            <div className="discovery-agent-reading">
              {state.discovery.reading.map((paper) => (
                <div key={paper.paperId} title={paper.title}>
                  <strong>{paper.title}</strong>
                  <span>
                    {paper.unavailable
                      ? `PDF 暂不可读：${paper.unavailable}`
                      : `已读 ${paper.pages.length}/${paper.totalPages || "?"} 页`}
                  </span>
                </div>
              ))}
            </div>
          )}
          <PaperResearchPlanView events={state.events} />
          <AgentCommentaryView events={state.events} live={running} />
          {!!state.discovery?.queries.length && (
            <details className="discovery-agent-queries">
              <summary>
                已执行 {state.discovery.queries.length} 次针对性查询
              </summary>
              {state.discovery.queries.map((item, index) => (
                <div key={index}>
                  <strong>{item.query}</strong>
                  <p>
                    {item.purpose} · {item.count} 篇候选
                  </p>
                </div>
              ))}
            </details>
          )}
          {state.content && (
            <article
              className="citation-ai-report knowledge-markdown"
              aria-label="AI 论文发现报告"
              onClick={(event) => {
                const match = (event.target as Element)
                  .closest("a")
                  ?.getAttribute("href")
                  ?.match(/^#discovery\/(C\d+)$/);
                if (!match) return;
                event.preventDefault();
                const result = state.discovery?.result;
                const candidate = result?.candidates.find(
                  (candidate) => candidate.aiRecommendation?.label === match[1],
                );
                if (candidate) onSelect(candidate.work);
              }}
            >
              <ChatMarkdown content={state.content} />
            </article>
          )}
          <AgentExecutionTrace events={state.events} live={running} />
        </>
      )}
      {state.error && (
        <p className="citation-ai-error" role="alert">
          {state.error}
        </p>
      )}
    </section>
  );
}
