import { useEffect, useState, useSyncExternalStore } from "react";
import { LoaderCircle, Sparkles } from "lucide-react";
import type { PaperChatController } from "./paperChatController";
import { ChatMarkdown } from "./ChatMarkdown";
import { formatProcessingDuration } from "./chatProgress";
import { PaperResearchPlanView } from "./PaperResearchPlanView";
import { AgentExecutionTrace } from "./AgentExecutionTrace";

export function ChatStreamView({
  store,
  paperId,
}: {
  store: PaperChatController;
  paperId: string;
}): React.JSX.Element | null {
  const { run } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (!run || run.paperId !== paperId) return null;

  const detail =
    run.status === "stopping"
      ? "正在停止生成…"
      : run.detail ||
        (run.status === "preparing"
          ? "正在准备文献与引用"
          : run.answer
            ? "正在生成回答"
            : "等待模型响应");

  return (
    <article
      className="message message-assistant pending-message chat-stream-message"
      aria-label="PaperXcel 正在回答"
    >
      <div className="message-label">
        <Sparkles size={14} /> PaperXcel
      </div>
      <div className="pending-status chat-stream-status">
        <LoaderCircle className="spin" size={15} aria-hidden="true" />
        <span role="status">{detail}</span>
        <ElapsedTime key={run.requestId} startedAt={run.startedAt} />
      </div>
      {run.reasoningObserved && (
        <small className="chat-reasoning-observed">已收到模型推理信号</small>
      )}
      <PaperResearchPlanView
        key={`${run.requestId}-plan`}
        events={run.events}
      />
      <AgentExecutionTrace key={run.requestId} events={run.events} live />
      {run.answer && (
        <div className="message-content pending-answer-content">
          <ChatMarkdown content={run.answer} />
        </div>
      )}
    </article>
  );
}

function ElapsedTime({ startedAt }: { startedAt: number }): React.JSX.Element {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);
  const elapsed = formatProcessingDuration(Math.max(1, now - startedAt));
  return <small aria-label={`已用时 ${elapsed}`}>{elapsed}</small>;
}
