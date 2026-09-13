import type {
  AskPaperInput,
  AskPaperResult,
  ChatAttachment,
  KnowledgeBaseMarkdownPreview,
  Paper,
} from "../shared/contracts";
import type { ResolvedChatAttachment } from "./chat-attachments";
import { ChatRun, type ChatAgentUpdate } from "./chat-run";
import {
  runPaperAgent,
  type PaperAgentDependencies,
} from "./paper-agent-runtime";
import type {
  createPaperAgentSession,
  compactPaperConversation,
} from "./provider";

/** Electron and disk access live at the boundary; the workflow is independently testable. */
export interface PaperChatDependencies extends PaperAgentDependencies {
  getPaper(paperId: string): Pick<Paper, "id" | "title"> | undefined;
  getProvider(): Parameters<typeof createPaperAgentSession>[0];
  compactConversation: typeof compactPaperConversation;
  resolveAttachments(
    attachments: ChatAttachment[] | undefined,
    paperId: string,
  ): Promise<ResolvedChatAttachment[]>;
  hydrateImages(
    snippets: AskPaperInput["selectedSnippets"],
  ): Promise<AskPaperInput["selectedSnippets"]>;
  repairMarkdown(
    paperId: string,
    requestId: string,
    signal: AbortSignal,
    onEvent: (event: ChatAgentUpdate) => void,
  ): Promise<KnowledgeBaseMarkdownPreview>;
}

export async function runPaperChat(
  input: AskPaperInput,
  run: ChatRun,
  dependencies: PaperChatDependencies,
): Promise<AskPaperResult> {
  run.check();
  const paper = dependencies.getPaper(input.paperId);
  if (!paper) throw new Error("文献不存在。");
  // Keep one provider configuration throughout the native agent conversation.
  const provider = dependencies.getProvider();
  run.event({
    type: "run.started",
    title:
      input.task === "repair-markdown"
        ? "从 PDF 重建 Markdown"
        : input.task === "compact"
          ? "压缩历史上下文"
          : "文献问答",
    detail: input.question,
    status: "running",
  });

  if (input.task === "compact") {
    run.progress({ phase: "waiting", detail: "正在等待模型返回上下文摘要" });
    run.event({
      type: "step.started",
      stepId: "compact",
      title: "压缩历史上下文",
      status: "running",
    });
    const result = await run.wait(() =>
      dependencies.compactConversation(provider, input.messages, {
        signal: run.signal,
        onProgress: run.progress,
      }),
    );
    run.event({
      type: "step.completed",
      stepId: "compact",
      title: "上下文压缩完成",
      status: "completed",
    });
    return result;
  }

  if (input.task === "repair-markdown") {
    run.event({
      type: "step.started",
      stepId: "repair",
      title: "从 PDF 重建 Markdown",
      detail: "逐页读取论文原始 PDF 并生成正文",
      status: "running",
    });
    run.progress({
      phase: "preparing",
      detail: "正在读取原始 PDF 并重新生成 Markdown",
    });
    const preview = await run.wait(() =>
      dependencies.repairMarkdown(
        input.paperId,
        run.requestId,
        run.signal,
        run.event,
      ),
    );
    run.event({
      type: "verification.completed",
      stepId: "verify",
      title: "逐页生成完成",
      detail: `已处理原始 PDF 共 ${preview.pageCount} 页并保存正文`,
      status: "completed",
    });
    run.event({
      type: "step.completed",
      stepId: "repair",
      title: "论文 Markdown 重建已完成",
      status: "completed",
    });
    const warnings = (preview.warnings ?? []).filter(Boolean);
    return {
      message: {
        id: crypto.randomUUID(),
        role: "assistant",
        content: [
          "已从原始 PDF 逐页重建 Markdown，结果已保存到当前论文。",
          warnings.length
            ? `兼容性提示：\n${warnings.map((warning) => `- ${warning}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        createdAt: new Date().toISOString(),
      },
      protocol: preview.protocol ?? "chat-completions",
      model: preview.model ?? provider.model,
      markdownPreview: { ...preview, paperId: paper.id },
    };
  }

  run.progress({ phase: "preparing", detail: "正在准备论文上下文" });
  run.event({
    type: "tool.started",
    title: "准备论文上下文",
    tool: "resolve_attachments",
    stepId: "prepare-context",
    metadata: { callId: "prepare-context" },
    status: "running",
  });
  const attachments = await run.wait(() =>
    dependencies.resolveAttachments(input.attachments, input.paperId),
  );
  run.event({
    type: "tool.completed",
    title: "论文上下文已准备",
    tool: "resolve_attachments",
    stepId: "prepare-context",
    metadata: { callId: "prepare-context" },
    detail: `已加载 ${attachments.length} 个附件`,
    status: "completed",
  });

  const selectedSnippets = await run.wait(() =>
    dependencies.hydrateImages(input.selectedSnippets),
  );
  return runPaperAgent(
    provider,
    { ...input, selectedSnippets, paperTitle: paper.title },
    attachments,
    run,
    dependencies,
  );
}
