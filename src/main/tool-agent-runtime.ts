import type { TokenUsage } from "../shared/contracts";
import type {
  PaperAgentSession,
  PaperAgentToolCall,
  PaperAgentToolResult,
  PaperAgentTurn,
} from "../shared/paperAgent";
import type { ChatRun } from "./chat-run";

/** Shared execution lifecycle for single-paper and library agents. */
export async function runToolAgent(
  session: PaperAgentSession,
  executeTool: (call: PaperAgentToolCall) => Promise<PaperAgentToolResult>,
  run: ChatRun,
  progressReasoning: () => boolean = () => false,
  limits: { maxTurns?: number; maxToolCalls?: number } = {},
): Promise<PaperAgentTurn> {
  const maxTurns = limits.maxTurns ?? 32;
  const maxToolCalls = limits.maxToolCalls ?? 48;
  let results: PaperAgentToolResult[] | undefined;
  let toolCount = 0;
  let usage: TokenUsage | undefined;
  let reasoningObserved = false;
  for (let index = 0; index < maxTurns; index++) {
    run.check();
    run.progress({
      phase: "waiting",
      detail: "正在等待模型响应",
      ...(index ? { answerContent: "" } : {}),
      reasoningObserved,
    });
    const turn = await run.wait(() => session.next(results));
    reasoningObserved ||=
      turn.reasoningObserved === true || progressReasoning();
    if (turn.tokenUsage) {
      const next = turn.tokenUsage;
      usage = {
        inputTokens: (usage?.inputTokens ?? 0) + next.inputTokens,
        cachedInputTokens:
          (usage?.cachedInputTokens ?? 0) + next.cachedInputTokens,
        outputTokens: (usage?.outputTokens ?? 0) + next.outputTokens,
        reasoningTokens: (usage?.reasoningTokens ?? 0) + next.reasoningTokens,
        totalTokens: (usage?.totalTokens ?? 0) + next.totalTokens,
      };
    }
    if (!turn.toolCalls.length) {
      if (!turn.content.trim())
        throw new Error("模型未返回回答或工具调用，请重试。");
      run.progress({
        phase: "answering",
        detail: "回答已生成",
        answerContent: turn.content,
        reasoningObserved,
        contextUsage: turn.contextUsage,
      });
      return { ...turn, tokenUsage: usage, reasoningObserved };
    }
    if (turn.content.trim())
      run.event({
        type: "assistant.message",
        title: "助手说明",
        detail: turn.content,
        metadata: { source: "model" },
      });
    run.progress({
      phase: "preparing",
      detail: "正在执行模型请求的工具",
      answerContent: "",
      reasoningObserved,
    });
    if (toolCount + turn.toolCalls.length > maxToolCalls)
      throw new Error(
        `本次任务已达到 ${maxToolCalls} 次工具调用的资源上限，任务尚未完成，请缩小问题范围后继续。`,
      );
    results = [];
    for (const call of turn.toolCalls) {
      run.check();
      results.push(await run.wait(() => executeTool(call)));
      toolCount++;
    }
  }
  throw new Error(
    `本次任务已达到 ${maxTurns} 次模型响应的资源上限。任务尚未完成，请缩小问题范围后继续。`,
  );
}
