import type { ChatProgress } from "../shared/contracts";

export function toPublicChatProgress(
  progress: Omit<ChatProgress, "requestId">,
): Omit<ChatProgress, "requestId"> {
  return {
    phase: progress.phase,
    detail: progress.detail,
    answerDelta: progress.answerDelta,
    answerContent: progress.answerContent,
    ...(progress.contextUsage ? { contextUsage: progress.contextUsage } : {}),
    ...(progress.reasoningObserved !== undefined
      ? { reasoningObserved: progress.reasoningObserved }
      : {}),
  };
}
