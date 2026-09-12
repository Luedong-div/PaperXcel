import type {
  AskPaperInput,
  AskPaperResult,
  ChatAttachment,
  KnowledgeBaseMarkdownPreview,
  Paper,
  ReferencedSnippet,
} from "../shared/contracts";
import type { ResolvedChatAttachment } from "./chat-attachments";
import { ChatRun, isChatAbortError, type ChatAgentUpdate } from "./chat-run";
import {
  mergePaperEvidence,
  type PaperEvidenceCandidate,
} from "./paper-research";
import type {
  askPaper,
  compactPaperConversation,
  planPaperResearch,
} from "./provider";

/** Electron and disk access live at the boundary; the workflow is independently testable. */
export interface PaperChatDependencies {
  getPaper(paperId: string): Pick<Paper, "id" | "title"> | undefined;
  getProvider(): Parameters<typeof askPaper>[0];
  askPaper: typeof askPaper;
  compactConversation: typeof compactPaperConversation;
  planResearch: typeof planPaperResearch;
  resolveAttachments(
    attachments: ChatAttachment[] | undefined,
    paperId: string,
  ): Promise<ResolvedChatAttachment[]>;
  includePaperPdf(
    paperId: string,
    attachments: ResolvedChatAttachment[],
    signal?: AbortSignal,
  ): Promise<ResolvedChatAttachment[]>;
  searchEvidence(
    paperId: string,
    query: string,
    limit?: number,
  ): Promise<PaperEvidenceCandidate[]>;
  hydrateImages(
    snippets: AskPaperInput["selectedSnippets"],
  ): Promise<AskPaperInput["selectedSnippets"]>;
  ensureMarkdown(paperId: string, signal?: AbortSignal): Promise<string>;
  repairMarkdown(
    paperId: string,
    requestId: string,
    signal: AbortSignal,
    markdownPath: string,
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
  // Keep one provider configuration for planning, generation and verification.
  const provider = dependencies.getProvider();
  run.event({
    type: "run.started",
    title:
      input.task === "repair-markdown"
        ? "修复论文 Markdown"
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

  run.progress({ phase: "preparing", detail: "正在准备论文上下文" });
  run.event({
    type: "tool.started",
    title: "准备论文上下文",
    tool: "resolve_attachments",
    status: "running",
  });
  let attachments = await run.wait(() =>
    dependencies.resolveAttachments(input.attachments, input.paperId),
  );
  run.event({
    type: "tool.completed",
    title: "论文上下文已准备",
    tool: "resolve_attachments",
    detail: `已加载 ${attachments.length} 个附件`,
    status: "completed",
  });

  if (input.task === "repair-markdown") {
    run.event({
      type: "step.started",
      stepId: "repair",
      title: "修复论文 Markdown",
      detail: "准备论文原始文件并调用修复服务",
      status: "running",
    });
    run.progress({
      phase: "preparing",
      detail: "正在读取论文全文文件并进行修复",
    });
    const markdownAttachment = attachments.find(
      ({ attachment }) =>
        attachment.kind === "text" &&
        /\.md(?:own)?$/i.test(attachment.fileName),
    );
    const markdownPath =
      markdownAttachment?.filePath ??
      (await run.wait(() =>
        dependencies.ensureMarkdown(input.paperId, run.signal),
      ));
    const preview = await run.wait(() =>
      dependencies.repairMarkdown(
        input.paperId,
        run.requestId,
        run.signal,
        markdownPath,
        run.event,
      ),
    );
    run.event({
      type: "verification.completed",
      stepId: "verify",
      title: "完整性校验通过",
      detail: `已校验 ${preview.pageCount} 页并写回全文缓存`,
      status: "completed",
    });
    run.event({
      type: "step.completed",
      stepId: "repair",
      title: "论文 Markdown 修复已完成",
      status: "completed",
    });
    const warnings = (preview.warnings ?? []).filter(Boolean);
    return {
      message: {
        id: crypto.randomUUID(),
        role: "assistant",
        content: [
          "文件修复已完成，结果已写入当前论文缓存。",
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

  let evidence: ReferencedSnippet[] = [];
  const completedSearches: Array<{ query: string; resultCount: number }> = [];
  let currentPlan: Array<{ id: string; title: string }> = [];
  const selectedEvidence = input.selectedSnippets?.length
    ? input.selectedSnippets
    : input.selectedText?.trim() && input.selectedPage
      ? [{ page: input.selectedPage, text: input.selectedText }]
      : [];
  const hasSelection = Boolean(
    input.selectedSnippets?.length ||
    (input.selectedText?.trim() && input.selectedPage),
  );
  const maxRounds = 3;
  for (let round = 1; round <= maxRounds; round++) {
    run.progress({
      phase: "waiting",
      detail: "正在等待模型分析问题与现有证据",
    });
    run.event({
      type: "tool.started",
      tool: "plan_paper_research",
      stepId: `decision-${round}`,
      title: `分析问题与证据 · 第 ${round} 轮`,
      detail: "正在请求模型决定回答或补充检索",
      status: "running",
    });
    let decision: Awaited<ReturnType<PaperChatDependencies["planResearch"]>>;
    try {
      decision = await run.wait(() =>
        dependencies.planResearch(
          provider,
          {
            question: input.question,
            paperTitle: paper.title,
            history: input.messages,
            reasoningEffort: input.reasoningEffort,
            completedSearches: completedSearches.map((search) => ({
              ...search,
            })),
            evidence: [...selectedEvidence, ...evidence],
            currentPlan,
            round,
            maxRounds,
          },
          { signal: run.signal },
        ),
      );
    } catch (error) {
      if (run.signal.aborted || isChatAbortError(error)) throw error;
      run.event({
        type: "tool.completed",
        tool: "plan_paper_research",
        stepId: `decision-${round}`,
        title: "模型决策暂不可用",
        detail: "将使用已取得的上下文；缺少证据时按原问题检索。",
        status: "failed",
      });
      if (!completedSearches.length && !hasSelection && input.question.trim()) {
        const searched = await searchEvidence(
          input.paperId,
          [input.question.trim()],
          run,
          dependencies,
        );
        completedSearches.push(...searched.searches);
        evidence = mergePaperEvidence(searched.evidence);
      }
      break;
    }
    run.event({
      type: "tool.completed",
      tool: "plan_paper_research",
      stepId: `decision-${round}`,
      title: `模型决策已返回 · 第 ${round} 轮`,
      detail:
        decision.action === "answer"
          ? "模型决定使用现有上下文回答"
          : "模型决定补充论文证据",
      status: "completed",
    });
    currentPlan = decision.plan;
    run.event({
      type: "plan.created",
      stepId: `decision-${round}`,
      title: decision.objective,
      detail: decision.analysisSummary,
      status: "completed",
      metadata: {
        source: "model",
        round,
        action: decision.action,
        analysisSummary: decision.analysisSummary,
        plan: currentPlan,
        queries: decision.queries,
        evidenceFocus: decision.evidenceFocus,
        evidenceCount: selectedEvidence.length + evidence.length,
      },
    });
    if (decision.action === "answer") break;
    const seen = new Set(completedSearches.map(({ query }) => queryKey(query)));
    const queries = decision.queries
      .map((query) => query.trim())
      .filter((query) => {
        const key = queryKey(query);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 4);
    if (!queries.length) break;
    const searched = await searchEvidence(
      input.paperId,
      queries,
      run,
      dependencies,
    );
    completedSearches.push(...searched.searches);
    evidence = mergePaperEvidence([...evidence, ...searched.evidence]);
  }
  const queries = completedSearches.length
    ? completedSearches.map(({ query }) => query)
    : [input.question.trim()].filter(Boolean);

  if (!evidence.length && !hasSelection) {
    attachments = await run.wait(() =>
      dependencies.includePaperPdf(input.paperId, attachments, run.signal),
    );
    run.event({
      type: "tool.completed",
      title: "已启用全文回退",
      tool: "resolve_attachments",
      detail: "本地检索未找到足够证据，使用当前论文原始 PDF",
      status: "completed",
    });
  }
  // Automatically added full-document context is unnecessary once local evidence exists.
  // Explicit user attachments still belong to the question and must be preserved.
  const answerAttachments = evidence.length
    ? attachments.filter(
        ({ attachment }) =>
          attachment.kind !== "pdf" ||
          input.attachments?.some((item) => item.id === attachment.id),
      )
    : attachments;
  const selectedSnippets = await run.wait(() =>
    dependencies.hydrateImages([
      ...(input.selectedSnippets ?? []),
      ...evidence,
    ]),
  );
  run.event({
    type: "step.started",
    stepId: "answer",
    title: "生成论文回答",
    detail: evidence.length
      ? `已整理 ${evidence.length} 段本地证据`
      : "正在使用当前论文上下文生成回答",
    status: "running",
  });
  let result = await run.wait(() =>
    dependencies.askPaper(
      provider,
      { ...input, selectedSnippets },
      {
        signal: run.signal,
        attachments: answerAttachments,
        onProgress: run.progress,
      },
    ),
  );

  if (evidence.length && !result.message.citations?.length) {
    run.event({
      type: "verification.started",
      stepId: "verify",
      title: "核验回答引用",
      detail: "回答缺少可定位的页码引用，正在扩大证据检索范围",
      status: "running",
    });
    const candidates = await searchEvidence(
      input.paperId,
      queries,
      run,
      dependencies,
      12,
    );
    const expandedEvidence = mergePaperEvidence(
      [...evidence, ...candidates.evidence],
      {
        maxItems: 24,
        maxCharacters: 72_000,
      },
    );
    const expandedSnippets = await run.wait(() =>
      dependencies.hydrateImages([
        ...(input.selectedSnippets ?? []),
        ...expandedEvidence,
      ]),
    );
    // The second generation replaces the draft; an explicit empty snapshot starts it.
    run.progress({
      phase: "waiting",
      detail: "正在依据补充证据重新生成回答",
      answerContent: "",
      reasoningObserved: false,
    });
    result = await run.wait(() =>
      dependencies.askPaper(
        provider,
        {
          ...input,
          question: `${input.question}\n\n请检查回答：必须只依据提供的论文证据回答，并在每个关键事实后添加 [p.页码] 引用。`,
          selectedSnippets: expandedSnippets,
        },
        {
          signal: run.signal,
          attachments: answerAttachments,
          onProgress: run.progress,
        },
      ),
    );
  }

  const citationCount = result.message.citations?.length ?? 0;
  const expectedCitations = Boolean(
    evidence.length ||
    input.selectedSnippets?.some(
      (snippet) => !snippet.imageOnly && snippet.text.trim(),
    ) ||
    (input.selectedText?.trim() && input.selectedPage),
  );
  result.message.citationVerification = expectedCitations
    ? citationCount > 0
      ? {
          status: "verified",
          detail: `已定位 ${citationCount} 条论文页码引用。`,
        }
      : {
          status: "unverified",
          detail: "回答未获得可定位页码引用，请把当前回答视为未验证结果。",
        }
    : {
        status: "not-applicable",
        detail: "本轮没有可用于页码定位的文本证据片段。",
      };
  run.event({
    type: "step.completed",
    stepId: "answer",
    title: "文献回答已生成",
    status: "completed",
  });
  run.event({
    type: "verification.completed",
    stepId: "verify",
    title:
      result.message.citationVerification.status === "unverified"
        ? "引用验证未通过"
        : "引用检查完成",
    detail: result.message.citationVerification.detail,
    status:
      result.message.citationVerification.status === "unverified"
        ? "failed"
        : "completed",
  });
  return result;
}

async function searchEvidence(
  paperId: string,
  queries: string[],
  run: ChatRun,
  dependencies: PaperChatDependencies,
  limit?: number,
): Promise<{
  evidence: PaperEvidenceCandidate[];
  searches: Array<{ query: string; resultCount: number }>;
}> {
  run.progress({
    phase: "searching",
    detail: limit ? "正在扩大论文证据检索范围" : "正在检索论文证据",
  });
  // The bounded searches are independent, but preserve query order when merging.
  const results = await run.wait(() =>
    Promise.all(
      queries.map(async (query, index) => {
        const tool = limit ? "search_paper_expanded" : "search_paper";
        run.event({
          type: "tool.started",
          title: `检索论文证据 ${index + 1}/${queries.length}`,
          tool,
          detail: query,
          status: "running",
          metadata: { query, queryIndex: index },
        });
        const hits = await run.wait(() =>
          dependencies.searchEvidence(paperId, query, limit),
        );
        run.event({
          type: "tool.completed",
          title: `证据检索完成 ${index + 1}/${queries.length}`,
          tool,
          detail: `${query}：${hits.length} 个片段`,
          status: "completed",
          metadata: { query, evidenceCount: hits.length },
        });
        return { query, hits: hits.map((hit) => ({ ...hit, query })) };
      }),
    ),
  );
  return {
    evidence: results.flatMap(({ hits }) => hits),
    searches: results.map(({ query, hits }) => ({
      query,
      resultCount: hits.length,
    })),
  };
}

function queryKey(query: string): string {
  return query
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
