import type { AskPaperInput, AskPaperResult } from "../shared/contracts";
import { extractCitations } from "../shared/citations";
import type { ResolvedChatAttachment } from "./chat-attachments";
import { ChatRun } from "./chat-run";
import {
  PAPER_AGENT_TOOLS,
  PaperAgentTools,
  type PaperAgentToolDependencies,
} from "./paper-agent-tools";
import type { createPaperAgentSession } from "./provider";
import { runToolAgent } from "./tool-agent-runtime";

export interface PaperAgentDependencies extends PaperAgentToolDependencies {
  createAgentSession: typeof createPaperAgentSession;
}

export async function runPaperAgent(
  provider: Parameters<typeof createPaperAgentSession>[0],
  input: AskPaperInput & { paperTitle?: string },
  attachments: ResolvedChatAttachment[],
  run: ChatRun,
  dependencies: PaperAgentDependencies,
): Promise<AskPaperResult> {
  const startedAt = Date.now();
  const tools = new PaperAgentTools(input.paperId, run, dependencies);
  let reasoningObserved = false;
  const session = await run.wait(() =>
    dependencies.createAgentSession(provider, input, PAPER_AGENT_TOOLS, {
      signal: run.signal,
      onProgress: (progress) => {
        reasoningObserved ||= progress.reasoningObserved === true;
        run.progress({ ...progress, reasoningObserved });
      },
      attachments,
    }),
  );
  const turn = await runToolAgent(
    session,
    (call) => tools.execute(call),
    run,
    () => reasoningObserved,
  );
  const selected = input.selectedSnippets?.length
    ? input.selectedSnippets
    : input.selectedText?.trim() && input.selectedPage
      ? [{ page: input.selectedPage, text: input.selectedText }]
      : [];
  const sources = [
    ...selected.map((snippet) => ({
      ...snippet,
      text: snippet.text.slice(0, 8000),
    })),
    ...tools.evidence,
  ]
    .filter((snippet) => !snippet.imageOnly && snippet.text.trim())
    .map((snippet, index) => ({
      chunk_id: `${input.paperId}:agent:${index + 1}:p${snippet.page}`,
      page: snippet.page,
      text: snippet.text,
    }));
  const citations = extractCitations(
    turn.content.replace(/\[p\.?\s*(\d+)\]/gi, "【p.$1】"),
    sources,
  ).filter((citation) => Boolean(citation.chunkId));
  return {
    message: {
      id: crypto.randomUUID(),
      role: "assistant",
      content: turn.content,
      citations,
      tokenUsage: turn.tokenUsage,
      contextCheckpoint: turn.contextCheckpoint,
      contextUsage: turn.contextUsage,
      reasoningObserved: turn.reasoningObserved,
      processingDurationMs: Date.now() - startedAt,
      createdAt: new Date().toISOString(),
    },
    protocol: turn.protocol,
    model: turn.model,
  };
}
