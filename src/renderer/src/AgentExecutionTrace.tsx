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
  const entries: Array<AgentEvent | AgentTraceEvent> = [];
  const toolEntries = new Map<string, number>();
  for (const event of events) {
    if (!EXECUTION_EVENTS.has(event.type)) continue;
    const callId =
      event.type === "tool.started" || event.type === "tool.completed"
        ? (event.metadata?.callId ?? event.metadata?.toolCallId ?? event.stepId)
        : undefined;
    if (typeof callId === "string" && callId) {
      const previous = toolEntries.get(callId);
      if (previous !== undefined) {
        // Keep one row per actual call; a later terminal event replaces its start.
        if (event.type === "tool.completed") entries[previous] = event;
        continue;
      }
      toolEntries.set(callId, entries.length);
    }
    entries.push(event);
  }
  if (!entries.length) return null;

  return (
    <details
      className={`message-agent-trace${live ? " chat-stream-trace" : ""}`}
    >
      <summary>工具与执行记录 · {entries.length} 项</summary>
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
