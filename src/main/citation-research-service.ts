import type { IpcMain } from "electron";
import type {
  CitationAnalysisInput,
  CitationAnalysisResult,
} from "../shared/citationAnalysisAgent";
import type {
  DiscoveryAgentInput,
  ResearchKind,
  ResearchScope,
  ResearchTurn,
} from "../shared/researchConversation";
import type {
  CitationDiscoveryFilters,
  DocumentPageText,
  Paper,
} from "../shared/contracts";
import { ResearchConversations } from "./research-conversations";
import { ChatRunRegistry, type ChatRun, type ChatSender } from "./chat-run";
import {
  buildCitationAnalysisCorpus,
  runCitationAnalysisAgent,
} from "./citation-analysis-agent";
import { runCitationDiscoveryAgent } from "./citation-discovery-agent";
import {
  discoverCitationWorks,
  createCitationDiscoverySession,
} from "./citation-discovery-service";
import { OpenAlexClient } from "./openalex-client";
import { CrossrefClient } from "./crossref-client";
import { EuropePmcClient } from "./europe-pmc-client";
import type { AppStore } from "./store";

export function registerCitationResearch(
  ipc: IpcMain,
  store: AppStore,
  directory: string,
  readPdf: (id: string, signal: AbortSignal) => Promise<DocumentPageText[]>,
) {
  const history = new ResearchConversations(directory);
  const registry = new ChatRunRegistry();
  ipc.handle("citation-graph:research-list", (_event, kind: ResearchKind) => {
    if (!["analysis", "discovery"].includes(kind))
      throw new Error("无效的研究类型。");
    return history.list(kind);
  });
  ipc.handle("citation-graph:research-get", (_event, id: string) =>
    history.get(id),
  );
  ipc.handle(
    "citation-graph:research-rename",
    (_event, id: string, title: string) => history.rename(id, title),
  );
  ipc.handle("citation-graph:research-delete", (_event, id: string) =>
    history.delete(id),
  );
  ipc.handle(
    "citation-graph:research-delete-turn",
    (_event, id: string, turnId: string) => history.deleteTurn(id, turnId),
  );
  ipc.handle("citation-graph:cancel-analysis", (event, id: string) =>
    registry.cancel(event.sender.id, id),
  );
  ipc.handle("citation-graph:cancel-discovery-agent", (event, id: string) =>
    registry.cancel(event.sender.id, id),
  );

  function prepare(
    kind: ResearchKind,
    input: CitationAnalysisInput | DiscoveryAgentInput,
  ) {
    if (
      !input ||
      typeof input.requestId !== "string" ||
      !input.requestId ||
      input.requestId.length > 100 ||
      !Array.isArray(input.paperIds) ||
      input.paperIds.some((id) => typeof id !== "string") ||
      (input.question !== undefined &&
        (typeof input.question !== "string" || input.question.length > 6000)) ||
      (input.scopeTurnId && !input.conversationId)
    )
      throw new Error("无效的研究请求，请检查论文范围与问题。");
    let scope: ResearchScope;
    const allPapers = store.listPapers();
    if (input.scopeTurnId)
      scope = history.scope(input.conversationId!, input.scopeTurnId, kind);
    else {
      if (!input.paperIds.length) throw new Error("请先选择本地论文。");
      const papers = input.paperIds.map((id) => {
        const paper = allPapers.find((paper) => paper.id === id);
        if (!paper) throw new Error("部分论文已不在资料库，请重新选择范围。");
        return paper;
      });
      const mode = "mode" in input ? input.mode : "standard";
      if (!["standard", "focused-two-hop"].includes(mode))
        throw new Error("无效的图谱范围。");
      const filters = "filters" in input ? input.filters : undefined;
      if (kind === "discovery") validateFilters(filters);
      scope = {
        paperIds: [...new Set(input.paperIds)],
        papers: papers.map(({ id, title, doi }) => ({ id, title, doi })),
        mode,
        snapshot:
          kind === "analysis"
            ? buildCitationAnalysisCorpus(
                papers,
                store.getCitationGraphCache(),
                mode,
              )
            : { nodes: [], edges: [], errors: [] },
        filters,
      };
    }
    const credentials = store.getActiveProvider();
    const previous = history.history(input.conversationId);
    const memory =
      kind === "analysis"
        ? history.memory(input.conversationId, scope)
        : undefined;
    const papers = scope.papers.map(
      (seed) =>
        allPapers.find((paper) => paper.id === seed.id) ??
        ({ ...seed, authors: [], tags: [] } as unknown as Paper),
    );
    return { scope, credentials, previous, memory, papers };
  }

  async function execute(
    kind: ResearchKind,
    sender: ChatSender,
    input: CitationAnalysisInput | DiscoveryAgentInput,
    scope: ResearchScope,
    model: string,
    operation: (
      run: ChatRun,
      id: string,
    ) => Promise<Partial<ResearchTurn> & { content: string }>,
  ) {
    if (sender.isDestroyed()) throw new Error("研究页面已关闭。");
    const question =
      input.question?.trim() ||
      (kind === "analysis"
        ? "识别研究主题、关键工作、演进路径、争议与研究机会。"
        : "根据所选论文发现相关进展、可比较方法与值得跟进的研究。");
    const ids = history.begin(kind, { ...input, question }, scope, model);
    const prefix = kind === "analysis" ? "analysis" : "discovery-agent";
    let answer: Partial<ResearchTurn> & { content: string } = { content: "" };
    try {
      const response = await registry.execute(
        {
          id: sender.id,
          // Still capture the final cancellation when the renderer has been destroyed.
          isDestroyed: () => false,
          once: (name, listener) => sender.once(name, listener),
          removeListener: (name, listener) =>
            sender.removeListener(name, listener),
          send: (channel, payload) => {
            history.capture(ids.conversationId, payload);
            if (!sender.isDestroyed())
              sender.send(
                `citation-graph:${prefix}-${channel === "chat:progress" ? "progress" : "event"}`,
                payload,
              );
          },
        },
        { requestId: input.requestId, paperId: `__citation_${kind}__` },
        async (run) => {
          run.event({
            type: "progress.updated",
            title: "研究对话已保存",
            metadata: { researchConversation: ids },
          });
          answer = await operation(run, ids.conversationId);
          return {
            message: {
              id: ids.turnId,
              role: "assistant",
              content: answer.content,
              createdAt: new Date().toISOString(),
            },
            model,
            protocol: "responses",
          };
        },
        kind === "analysis" ? "AI 引文网络分析完成" : "AI 论文发现完成",
      );
      history.finish(
        ids.conversationId,
        "cancelled" in response
          ? { status: "cancelled", content: response.answerContent ?? "" }
          : { ...answer, status: "completed" },
      );
      return ids;
    } catch (error) {
      history.finish(ids.conversationId, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  ipc.handle(
    "citation-graph:analyze",
    async (
      event,
      input: CitationAnalysisInput,
    ): Promise<CitationAnalysisResult> => {
      const { scope, credentials, previous, memory } = prepare(
        "analysis",
        input,
      );
      const ids = await execute(
        "analysis",
        event.sender,
        input,
        scope,
        credentials.model,
        async (run, id) => {
          const analysisResult = await runCitationAnalysisAgent(
            credentials,
            { ...input, mode: scope.mode },
            scope.snapshot,
            run,
            undefined,
            {
              history: previous,
              memory,
              onMemory: (memory) => history.checkpoint(id, memory),
            },
          );
          return {
            content: analysisResult.content,
            model: analysisResult.model,
            research: analysisResult,
            analysisResult,
          };
        },
      );
      const turn = history
        .get(ids.conversationId)
        .turns.find((turn) => turn.id === ids.turnId)!;
      return {
        ...ids,
        content: turn.content,
        model: turn.model,
        cancelled: turn.status === "cancelled",
        coverage: turn.research?.coverage ?? {
          total: scope.snapshot.nodes.length,
          read: 0,
          noted: 0,
          withAbstract: 0,
          readWithAbstract: 0,
        },
        findings: turn.research?.findings ?? [],
        ...turn.analysisResult,
      };
    },
  );
  ipc.handle(
    "citation-graph:discover-with-ai",
    async (event, input: DiscoveryAgentInput) => {
      const { scope, credentials, previous, papers } = prepare(
        "discovery",
        input,
      );
      const searches = new Map<
        string,
        ReturnType<typeof createCitationDiscoverySession>
      >();
      return execute(
        "discovery",
        event.sender,
        input,
        scope,
        credentials.model,
        (run) =>
          runCitationDiscoveryAgent(
            credentials,
            { ...input, filters: scope.filters },
            papers,
            run,
            {
              readPdf,
              search: async (query, limit, signal) => {
                let session = searches.get(query);
                if (!session) {
                  session = createCitationDiscoverySession();
                  searches.set(query, session);
                }
                return (
                  await discoverCitationWorks({
                    papers,
                    cache: store.getCitationGraphCache(),
                    client: new OpenAlexClient(store.resolveOpenAlexApiKey()),
                    crossref: new CrossrefClient(),
                    europePmc: new EuropePmcClient(),
                    mode: "pure-search",
                    query,
                    limit,
                    filters: scope.filters,
                    session,
                    signal,
                  })
                ).result;
              },
            },
            previous,
          ),
      );
    },
  );
  return {
    cancelAll: () => {
      registry.cancelAll();
      history.flush();
    },
  };
}

function validateFilters(filters?: CitationDiscoveryFilters) {
  if (!filters) return;
  if (
    [filters.yearFrom, filters.yearTo].some(
      (year) =>
        year !== undefined &&
        (!Number.isInteger(year) || year < 1500 || year > 2100),
    ) ||
    (filters.yearFrom && filters.yearTo && filters.yearFrom > filters.yearTo) ||
    (filters.sources &&
      (!Array.isArray(filters.sources) ||
        !filters.sources.length ||
        filters.sources.some(
          (source) => !["openalex", "crossref", "europe-pmc"].includes(source),
        )))
  )
    throw new Error("请检查检索年份与来源筛选。");
}
