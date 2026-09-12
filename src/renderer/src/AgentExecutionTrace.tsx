import { memo } from "react";
import { Check, CircleAlert, Square } from "lucide-react";
import type { AgentEvent, AgentTraceEvent } from "../../shared/contracts";

const EXECUTION_EVENTS = new Set([
  "tool.started",
  "tool.completed",
  "step.started",
  "step.completed",
  "verification.started",
  "verification.completed",
  "run.failed",
  "run.cancelled",
]);

export const AgentExecutionTrace = memo(function AgentExecutionTrace({
  events,
  live = false,
}: {
  events: Array<AgentEvent | AgentTraceEvent>;
  live?: boolean;
}): React.JSX.Element | null {
  const entries = events.filter((event) => EXECUTION_EVENTS.has(event.type));
  if (!entries.length) return null;

  return (
    <details
      className={`message-agent-trace${live ? " chat-stream-trace" : ""}`}
    >
      <summary>执行记录 · {entries.length} 项</summary>
      <div className="message-agent-trace-list">
        {entries.map((event, index) => {
          const cancelled = event.type === "run.cancelled";
          const failed =
            !cancelled &&
            (event.status === "failed" || event.type === "run.failed");
          const completed = event.type.endsWith(".completed") && !failed;
          return (
            <div
              className={`agent-run-event ${failed ? "failed" : completed ? "completed" : ""}`}
              key={`${index}-${event.type}`}
            >
              {failed ? (
                <CircleAlert size={13} aria-label="执行失败" />
              ) : cancelled ? (
                <Square size={12} aria-label="已停止" />
              ) : completed ? (
                <Check size={13} aria-label="已完成" />
              ) : (
                <span className="agent-execution-dot" aria-label="已开始" />
              )}
              <span>
                <strong>{event.title}</strong>
                {event.detail && <small>{event.detail}</small>}
              </span>
            </div>
          );
        })}
      </div>
    </details>
  );
});
