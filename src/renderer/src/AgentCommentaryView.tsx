import { memo } from "react";
import type { AgentEvent, AgentTraceEvent } from "../../shared/contracts";
import { ChatMarkdown } from "./ChatMarkdown";

/** Public assistant messages before tool calls, never inferred reasoning. */
export const AgentCommentaryView = memo(function AgentCommentaryView({
  events,
  live = false,
}: {
  events: Array<AgentEvent | AgentTraceEvent>;
  live?: boolean;
}): React.JSX.Element | null {
  const messages = events.flatMap((event, index) => {
    if (event.type !== "assistant.message") return [];
    const content =
      (typeof event.metadata?.content === "string"
        ? event.metadata.content.trim()
        : "") || event.detail?.trim();
    return content ? [{ id: index, content }] : [];
  });
  if (!messages.length) return null;
  const older = messages.slice(0, -3);
  const recent = messages.slice(-3);
  const renderMessage = (message: (typeof messages)[number]) => (
    <div className="agent-commentary-message" key={message.id}>
      <ChatMarkdown content={message.content} />
    </div>
  );

  return (
    <section className="agent-commentary" aria-label="AI 工作说明">
      <small className="agent-commentary-label">工作说明</small>
      {older.length > 0 && (
        <details className="agent-commentary-history">
          <summary>较早的说明 · {older.length} 条</summary>
          {older.map(renderMessage)}
        </details>
      )}
      <div aria-live={live ? "polite" : undefined}>
        {recent.map(renderMessage)}
      </div>
    </section>
  );
});
