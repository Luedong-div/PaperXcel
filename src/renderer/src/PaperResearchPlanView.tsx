import { memo } from "react";
import type { AgentEvent, AgentTraceEvent } from "../../shared/contracts";

type ResearchEvent = AgentEvent | AgentTraceEvent;

/** Displays only the model's public analysis and proposed actions. */
export const PaperResearchPlanView = memo(function PaperResearchPlanView({
  events,
}: {
  events: ResearchEvent[];
}): React.JSX.Element | null {
  const event = [...events]
    .reverse()
    .find(
      (item) =>
        item.type === "plan.created" && item.metadata?.source === "model",
    );
  const metadata = event?.metadata;
  if (!metadata) return null;
  const analysis =
    typeof metadata.analysisSummary === "string"
      ? metadata.analysisSummary.trim()
      : "";
  const plan = Array.isArray(metadata.plan)
    ? metadata.plan.flatMap((item: unknown) => {
        if (!item || typeof item !== "object") return [];
        const step = item as Record<string, unknown>;
        return typeof step.title === "string" && step.title.trim()
          ? [
              {
                id: typeof step.id === "string" ? step.id : "",
                title: step.title.trim(),
              },
            ]
          : [];
      })
    : [];
  if (!analysis && !plan.length) return null;
  const queries = Array.isArray(metadata.queries)
    ? metadata.queries.filter(
        (query): query is string =>
          typeof query === "string" && Boolean(query.trim()),
      )
    : [];
  const round = positiveInteger(metadata.round);
  const evidenceCount = positiveInteger(metadata.evidenceCount);
  const action =
    metadata.action === "search"
      ? "继续检索"
      : metadata.action === "answer"
        ? "组织回答"
        : "";

  return (
    <details className="paper-research-plan" open>
      <summary>
        <span>分析与计划</span>
        <small>
          {[round ? `第 ${round} 轮` : "", action].filter(Boolean).join(" · ")}
        </small>
      </summary>
      <div className="paper-research-plan-body">
        {analysis && <p className="paper-research-analysis">{analysis}</p>}
        {plan.length > 0 && (
          <ol
            className="paper-research-plan-steps"
            aria-label="模型提出的研究计划"
          >
            {plan.map((step, index) => (
              <li key={`${step.id}-${index}`}>{step.title}</li>
            ))}
          </ol>
        )}
        {queries.length > 0 && metadata.action === "search" && (
          <div className="paper-research-queries" aria-label="本轮检索式">
            {queries.map((query, index) => (
              <code key={`${index}-${query}`}>{query}</code>
            ))}
          </div>
        )}
        {evidenceCount !== undefined && (
          <small className="paper-research-evidence-count">
            已提供 {evidenceCount} 段论文证据
          </small>
        )}
      </div>
    </details>
  );
});

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}
