import { memo } from "react";
import { Check, Circle, CircleDot } from "lucide-react";
import type { AgentEvent, AgentTraceEvent } from "../../shared/contracts";

type ResearchEvent = AgentEvent | AgentTraceEvent;

/** Task titles and progress are supplied by the model's update_plan call. */
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
    [metadata.explanation, metadata.analysisSummary, event.detail]
      .find(
        (value): value is string =>
          typeof value === "string" && Boolean(value.trim()),
      )
      ?.trim() ?? "";
  const plan = Array.isArray(metadata.plan)
    ? metadata.plan.flatMap((item: unknown) => {
        if (!item || typeof item !== "object") return [];
        const step = item as Record<string, unknown>;
        return typeof step.title === "string" && step.title.trim()
          ? [
              {
                id: typeof step.id === "string" ? step.id : "",
                title: step.title.trim(),
                status:
                  step.status === "completed" || step.status === "in_progress"
                    ? step.status
                    : "pending",
              },
            ]
          : [];
      })
    : [];
  if (!analysis && !plan.length) return null;
  const completedCount = plan.filter(
    (step) => step.status === "completed",
  ).length;

  return (
    <details className="paper-research-plan" open>
      <summary>
        <span>任务计划</span>
        <small>
          {plan.length > 0 ? ` · ${completedCount}/${plan.length} 已完成` : ""}
        </small>
      </summary>
      <div className="paper-research-plan-body">
        {analysis && <p className="paper-research-analysis">{analysis}</p>}
        {plan.length > 0 && (
          <ol
            className="paper-research-plan-steps"
            aria-label="模型制定的任务计划"
          >
            {plan.map((step, index) => {
              const statusLabel =
                step.status === "completed"
                  ? "已完成"
                  : step.status === "in_progress"
                    ? "进行中"
                    : "待处理";
              return (
                <li
                  key={`${step.id}-${index}`}
                  className={`paper-research-step is-${step.status}`}
                  data-status={step.status}
                  aria-label={`${step.title}：${statusLabel}`}
                >
                  {step.status === "completed" ? (
                    <Check size={15} aria-hidden="true" />
                  ) : step.status === "in_progress" ? (
                    <CircleDot size={15} aria-hidden="true" />
                  ) : (
                    <Circle size={15} aria-hidden="true" />
                  )}
                  <span>{step.title}</span>
                  <small>{statusLabel}</small>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </details>
  );
});
