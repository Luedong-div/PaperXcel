/** One application budget for every provider/model; K uses decimal tokens. */
export const ASSISTANT_CONTEXT_TOKENS = 273_000;

export interface AssistantContextUsage {
  inputTokens: number;
  limitTokens: number;
  compactions: number;
}

export interface AssistantHistoryMessage {
  role: "user" | "assistant";
  content: string;
  contextCheckpoint?: string;
  task?: string;
  status?: string;
}

/** Keep readable history on disk; checkpoints replace only the model's input. */
export function assistantConversationHistory(
  messages: AssistantHistoryMessage[],
): Array<{ role: "user" | "assistant"; content: string }> {
  const completed = messages.filter(
    (message) => !message.status || message.status === "complete",
  );
  for (let index = completed.length - 1; index >= 0; index--) {
    const message = completed[index];
    if (message.role !== "assistant") continue;
    if (message.contextCheckpoint?.trim()) {
      return [
        { role: "assistant", content: message.contextCheckpoint },
        ...completed
          .slice(index)
          .map(({ role, content }) => ({ role, content })),
      ];
    }
    if (message.task === "compact" && message.content.trim())
      return completed
        .slice(index)
        .map(({ role, content }) => ({ role, content }));
  }
  return completed.map(({ role, content }) => ({ role, content }));
}
