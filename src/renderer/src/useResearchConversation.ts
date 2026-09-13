import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent, ChatProgress } from "../../shared/contracts";
import type {
  CitationAnalysisInput,
  CitationAnalysisResult,
  CitationAnalysisState,
} from "../../shared/citationAnalysisAgent";
import type {
  DiscoveryAgentInput,
  DiscoveryAgentState,
  ResearchConversation,
  ResearchConversationSummary,
  ResearchKind,
  ResearchTurn,
} from "../../shared/researchConversation";

export interface ResearchViewState {
  status: "idle" | "stopping" | ResearchTurn["status"];
  content: string;
  events: AgentEvent[];
  progress?: ChatProgress;
  research?: CitationAnalysisState;
  result?: CitationAnalysisResult;
  discovery?: DiscoveryAgentState;
  error?: string;
}
const empty = (): ResearchViewState => ({
  status: "idle",
  content: "",
  events: [],
});
const view = (turn: ResearchTurn): ResearchViewState => ({
  ...turn,
  result: turn.analysisResult,
});
type Input =
  | Omit<CitationAnalysisInput, "requestId">
  | Omit<DiscoveryAgentInput, "requestId">;
type Active = {
  id: string;
  progressSequence: number;
  eventSequence: number;
  conversationId?: string;
  turnId?: string;
};
type ManagementAction =
  | { type: "rename"; title: string }
  | { type: "delete" }
  | { type: "delete-turn"; turnId: string };

/** Main-process history is authoritative; reloads reconnect without starting another model run. */
export function useResearchConversation(kind: ResearchKind) {
  const [state, setState] = useState<ResearchViewState>(empty);
  const [conversation, setConversation] = useState<ResearchConversation>();
  const [sessions, setSessions] = useState<ResearchConversationSummary[]>([]);
  const [turnId, setTurnId] = useState<string>();
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [managing, setManaging] = useState(false);
  const management = useRef(false);
  const listRevision = useRef(0);
  const active = useRef<Active | undefined>(undefined);
  const selected = useRef<{ id?: string; turnId?: string }>({});
  const navigation = useRef(0);
  const mounted = useRef(false);
  const storageKey = `paperxcel-research-${kind}`;
  const remember = useCallback(
    (id?: string, selectedTurn?: string) => {
      selected.current = { id, turnId: selectedTurn };
      try {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({ id: id ?? "new", turnId: selectedTurn }),
        );
      } catch {
        /* History is still stored by main. */
      }
    },
    [storageKey],
  );
  const adopt = useCallback(
    (next: ResearchConversation, requestedTurn?: string) => {
      const turn =
        next.turns.find((turn) => turn.id === requestedTurn) ??
        next.turns.at(-1);
      setConversation(next);
      setTurnId(turn?.id);
      remember(next.id, turn?.id);
      if (!turn) {
        active.current = undefined;
        setState(empty());
        return;
      }
      const current = active.current;
      const eventSequence = turn.events.at(-1)?.sequence ?? 0;
      const progressSequence = turn.progress?.sequence ?? 0;
      setState((state) => ({
        ...view(turn),
        ...(turn.status === "running" &&
        current?.id === turn.requestId &&
        current.progressSequence > progressSequence
          ? { content: state.content, progress: state.progress }
          : {}),
        ...(turn.status === "running" &&
        current?.id === turn.requestId &&
        current.eventSequence > eventSequence
          ? {
              events: state.events,
              research: state.research,
              discovery: state.discovery,
            }
          : {}),
      }));
      active.current =
        turn.status === "running"
          ? {
              id: turn.requestId,
              conversationId: next.id,
              turnId: turn.id,
              eventSequence: Math.max(
                current?.id === turn.requestId ? current.eventSequence : 0,
                eventSequence,
              ),
              progressSequence: Math.max(
                current?.id === turn.requestId ? current.progressSequence : 0,
                progressSequence,
              ),
            }
          : undefined;
    },
    [remember],
  );
  const refreshList = useCallback(async () => {
    const revision = ++listRevision.current;
    const summaries =
      await window.paperxcel.citationGraph.listResearchConversations(kind);
    if (mounted.current && revision === listRevision.current)
      setSessions(summaries);
    return summaries;
  }, [kind]);
  const open = useCallback(
    async (id: string, selectedTurn?: string) => {
      if (management.current) return;
      const version = ++navigation.current;
      setLoadingHistory(true);
      try {
        const next =
          await window.paperxcel.citationGraph.getResearchConversation(id);
        if (mounted.current && version === navigation.current)
          adopt(next, selectedTurn);
      } catch (error) {
        if (mounted.current && version === navigation.current)
          setState((current) => ({ ...current, error: String(error) }));
      } finally {
        if (mounted.current && version === navigation.current)
          setLoadingHistory(false);
      }
    },
    [adopt],
  );
  useEffect(() => {
    mounted.current = true;
    const version = ++navigation.current;
    void refreshList()
      .then(async (summaries) => {
        if (!mounted.current || version !== navigation.current) return;
        let saved: { id?: string; turnId?: string } = {};
        try {
          saved = JSON.parse(sessionStorage.getItem(storageKey) || "{}");
        } catch {
          /* Use most recent conversation. */
        }
        const id =
          saved.id === "new"
            ? undefined
            : (summaries.find((session) => session.id === saved.id)?.id ??
              summaries[0]?.id);
        if (id) await open(id, saved.turnId);
      })
      .catch((error) => {
        if (mounted.current)
          setState((current) => ({
            ...current,
            error: `无法读取研究对话：${String(error)}`,
          }));
      })
      .finally(() => {
        if (mounted.current) setLoadingHistory(false);
      });
    return () => {
      mounted.current = false;
    };
  }, [open, refreshList, storageKey]);

  useEffect(() => {
    const api = window.paperxcel.citationGraph;
    const onProgress = (progress: ChatProgress) => {
      const request = active.current;
      if (
        !request ||
        request.id !== progress.requestId ||
        (progress.sequence ?? 0) <= request.progressSequence
      )
        return;
      request.progressSequence = progress.sequence ?? 0;
      setState((current) => ({
        ...current,
        progress,
        content:
          progress.answerContent !== undefined
            ? progress.answerContent
            : current.content + (progress.answerDelta ?? ""),
      }));
    };
    const onEvent = (event: AgentEvent) => {
      const request = active.current;
      if (
        !request ||
        request.id !== event.requestId ||
        event.sequence <= request.eventSequence
      )
        return;
      request.eventSequence = event.sequence;
      const ids = event.metadata?.researchConversation as
        | { conversationId: string; turnId: string }
        | undefined;
      if (ids) {
        request.conversationId = ids.conversationId;
        request.turnId = ids.turnId;
        remember(ids.conversationId, ids.turnId);
      }
      const metadata = { ...event.metadata };
      delete metadata.citationAnalysis;
      delete metadata.citationDiscovery;
      setState((current) => ({
        ...current,
        events: [...current.events, { ...event, metadata }],
        research:
          (event.metadata
            ?.citationAnalysis as unknown as CitationAnalysisState) ??
          current.research,
        discovery:
          (event.metadata
            ?.citationDiscovery as unknown as DiscoveryAgentState) ??
          current.discovery,
      }));
    };
    const progressOff =
      kind === "analysis"
        ? api.onAnalysisProgress(onProgress)
        : api.onDiscoveryAgentProgress(onProgress);
    const eventOff =
      kind === "analysis"
        ? api.onAnalysisEvent(onEvent)
        : api.onDiscoveryAgentEvent(onEvent);
    // Poll also recovers saved scope and terminal state when a refresh missed SSE/IPC events.
    let fetching = false;
    const timer = setInterval(() => {
      const request = active.current;
      if (!request?.conversationId || fetching) return;
      fetching = true;
      const version = navigation.current;
      void api
        .getResearchConversation(request.conversationId)
        .then((next) => {
          if (
            mounted.current &&
            version === navigation.current &&
            active.current?.id === request.id
          )
            adopt(next, request.turnId);
        })
        .catch((error) => {
          if (mounted.current)
            setState((state) => ({ ...state, error: String(error) }));
        })
        .finally(() => {
          fetching = false;
        });
    }, 1200);
    return () => {
      progressOff();
      eventOff();
      clearInterval(timer);
    };
  }, [adopt, kind, remember]);

  const start = useCallback(
    async (input: Input) => {
      if (active.current || management.current) return;
      const version = ++navigation.current;
      const request: Active = {
        id: crypto.randomUUID(),
        progressSequence: 0,
        eventSequence: 0,
      };
      active.current = request;
      setLoadingHistory(false);
      setTurnId(undefined);
      setState({ ...empty(), status: "running" });
      const invocation = {
        ...input,
        conversationId: input.conversationId ?? selected.current.id,
        requestId: request.id,
      };
      try {
        const result =
          kind === "analysis"
            ? await window.paperxcel.citationGraph.analyze(
                invocation as CitationAnalysisInput,
              )
            : await window.paperxcel.citationGraph.discoverWithAi(
                invocation as DiscoveryAgentInput,
              );
        if (!mounted.current || version !== navigation.current) return;
        if (result.conversationId) {
          const next =
            await window.paperxcel.citationGraph.getResearchConversation(
              result.conversationId,
            );
          if (mounted.current && version === navigation.current)
            adopt(next, result.turnId);
        }
      } catch (error) {
        if (!mounted.current || version !== navigation.current) return;
        if (request.conversationId) {
          try {
            const next =
              await window.paperxcel.citationGraph.getResearchConversation(
                request.conversationId,
              );
            if (mounted.current && version === navigation.current)
              adopt(next, request.turnId);
          } catch {
            /* Keep streamed work visible if the history read also fails. */
          }
        }
        if (mounted.current && version === navigation.current)
          setState((current) => ({
            ...current,
            status: "failed",
            error: String(error),
          }));
      } finally {
        if (mounted.current && version === navigation.current) {
          active.current = undefined;
          void refreshList().catch(() => {});
        }
      }
    },
    [adopt, kind, refreshList],
  );
  const stop = useCallback(() => {
    const request = active.current;
    if (!request) return;
    setState((current) => ({ ...current, status: "stopping" }));
    const api = window.paperxcel.citationGraph;
    void (
      kind === "analysis"
        ? api.cancelAnalysis(request.id)
        : api.cancelDiscoveryAgent(request.id)
    )
      .then((cancelled) => {
        if (!cancelled && active.current?.id === request.id)
          setState((state) => ({
            ...state,
            status: "running",
            error: "该任务已结束或由另一个窗口运行，正在同步保存状态。",
          }));
      })
      .catch((error) => {
        if (active.current?.id === request.id)
          setState((state) => ({
            ...state,
            status: "running",
            error: String(error),
          }));
      });
  }, [kind]);
  const newConversation = useCallback(() => {
    if (active.current || management.current) return;
    navigation.current++;
    remember();
    setConversation(undefined);
    setTurnId(undefined);
    setState(empty());
    setLoadingHistory(false);
  }, [remember]);
  const manageConversation = useCallback(
    async (action: ManagementAction) => {
      const id = selected.current.id;
      if (!id) throw new Error("请先选择研究对话。");
      if (active.current || management.current)
        throw new Error("请等待当前操作完成后再管理对话。");
      management.current = true;
      setManaging(true);
      try {
        const api = window.paperxcel.citationGraph;
        if (action.type === "rename") {
          const summary = await api.renameResearchConversation(
            id,
            action.title,
          );
          if (!mounted.current) return;
          listRevision.current++;
          setSessions((current) =>
            [summary, ...current.filter((session) => session.id !== id)].sort(
              (a, b) => b.updatedAt.localeCompare(a.updatedAt),
            ),
          );
          setConversation((current) =>
            current?.id === id
              ? {
                  ...current,
                  title: summary.title,
                  updatedAt: summary.updatedAt,
                }
              : current,
          );
        } else if (action.type === "delete-turn") {
          const next = await api.deleteResearchTurn(id, action.turnId);
          if (!mounted.current) return;
          const { turns, ...metadata } = next;
          const last = turns.at(-1);
          const summary: ResearchConversationSummary = {
            ...metadata,
            turnCount: turns.length,
            status: last?.status ?? "idle",
            paperTitles: last?.scope.papers.map((paper) => paper.title) ?? [],
          };
          listRevision.current++;
          setSessions((current) =>
            [summary, ...current.filter((session) => session.id !== id)].sort(
              (a, b) => b.updatedAt.localeCompare(a.updatedAt),
            ),
          );
          if (selected.current.id === id) {
            navigation.current++;
            const index =
              conversation?.turns.findIndex(
                (turn) => turn.id === action.turnId,
              ) ?? -1;
            const nextTurn =
              selected.current.turnId === action.turnId
                ? (conversation?.turns[index - 1]?.id ?? turns[0]?.id)
                : selected.current.turnId;
            adopt(next, nextTurn);
          }
        } else {
          await api.deleteResearchConversation(id);
          if (!mounted.current) return;
          listRevision.current++;
          setSessions((current) =>
            current.filter((session) => session.id !== id),
          );
          if (selected.current.id === id) {
            navigation.current++;
            remember();
            setConversation(undefined);
            setTurnId(undefined);
            setState(empty());
            setLoadingHistory(false);
          }
        }
      } finally {
        management.current = false;
        if (mounted.current) setManaging(false);
      }
    },
    [adopt, conversation, remember],
  );
  const selectTurn = useCallback(
    (id: string) => {
      if (conversation && !active.current && !management.current)
        adopt(conversation, id);
    },
    [adopt, conversation],
  );
  const turn = conversation?.turns.find((turn) => turn.id === turnId);
  return {
    state,
    conversation,
    sessions,
    turn,
    loadingHistory,
    managing,
    start,
    stop,
    open,
    newConversation,
    rename: (title: string) => manageConversation({ type: "rename", title }),
    deleteConversation: () => manageConversation({ type: "delete" }),
    deleteTurn: (turnId: string) =>
      manageConversation({ type: "delete-turn", turnId }),
    selectTurn,
    running: state.status === "running" || state.status === "stopping",
  };
}
