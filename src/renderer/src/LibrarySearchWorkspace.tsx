import {
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  FileSearch,
  LoaderCircle,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AgentEvent,
  ChatProgress,
  LibraryAskHistoryMessage,
  LibraryAskResult,
  LibrarySearchHit,
  ModelReasoningEffort,
  Paper,
  ProviderProfile,
} from "../../shared/contracts";

import { ChatMarkdown } from "./ChatMarkdown";
import { PaperResearchPlanView } from "./PaperResearchPlanView";
import { AgentExecutionTrace } from "./AgentExecutionTrace";
import { AgentCommentaryView } from "./AgentCommentaryView";

interface LibrarySearchWorkspaceProps {
  papers: Paper[];
  provider?: ProviderProfile;
  models: string[];
  query: string;
  results: LibrarySearchHit[];
  searching: boolean;
  searched: boolean;
  reasoningEffort: ModelReasoningEffort;
  onModelChange: (model: string) => Promise<void> | void;
  onReasoningChange: (effort: ModelReasoningEffort) => void;
  onQueryChange: (query: string) => void;
  onSearch: (query?: string) => void;
  onOpenHit: (paperId: string, page: number) => void;
  onError: (message: string) => void;
}

interface LibraryChatTurn {
  id: string;
  question: string;
  selectedCount: number;
  requestId?: string;
  streamingContent?: string;
  reasoningObserved?: boolean;
  detail?: string;
  contextUsage?: import("../../shared/assistantContext").AssistantContextUsage;
  agentEvents?: AgentEvent[];
  answer?: LibraryAskResult;
  error?: string;
}

type LibraryModelMenuSection = "model" | "reasoning";

const LIBRARY_CHAT_STORAGE_KEY = "paperxcel.library-search.chat";
const LIBRARY_SELECTED_HITS_STORAGE_KEY =
  "paperxcel.library-search.selected-hits";
const LIBRARY_ASSISTANT_WIDTH_STORAGE_KEY =
  "paperxcel.library-search.assistant-width";
const MAX_LIBRARY_CONTEXT_HITS = 30;

const DEFAULT_LIBRARY_ASSISTANT_WIDTH = 500;
const MIN_LIBRARY_ASSISTANT_WIDTH = 320;
const MAX_LIBRARY_ASSISTANT_WIDTH = 720;
const MIN_LIBRARY_RESULTS_WIDTH = 360;
const LIBRARY_ASSISTANT_RESIZE_HANDLE_WIDTH = 8;
const LIBRARY_ASSISTANT_STACK_BREAKPOINT = 720;

const reasoningOptions: Array<{
  value: ModelReasoningEffort;
  label: string;
}> = [
  { value: "none", label: "不推理" },
  { value: "low", label: "轻度" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
];

function libraryHitKey(hit: LibrarySearchHit): string {
  return `${hit.paperId}:${hit.chunkId}`;
}

function readStoredChatTurns(): LibraryChatTurn[] {
  try {
    const stored = window.sessionStorage.getItem(LIBRARY_CHAT_STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as LibraryChatTurn[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (turn) =>
        typeof turn?.id === "string" &&
        typeof turn.question === "string" &&
        typeof turn.selectedCount === "number" &&
        (turn.answer || turn.error),
    );
  } catch {
    return [];
  }
}

function readStoredSelectedHitKeys(): Set<string> {
  try {
    const stored = window.sessionStorage.getItem(
      LIBRARY_SELECTED_HITS_STORAGE_KEY,
    );
    if (!stored) return new Set();
    const parsed = JSON.parse(stored) as string[];
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((value) => typeof value === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function clampLibraryAssistantWidth(
  width: number,
  maxWidth = MAX_LIBRARY_ASSISTANT_WIDTH,
): number {
  return Math.min(
    Math.max(width, MIN_LIBRARY_ASSISTANT_WIDTH),
    Math.max(MIN_LIBRARY_ASSISTANT_WIDTH, maxWidth),
  );
}

function readStoredAssistantWidth(): number {
  try {
    const stored = Number.parseFloat(
      window.localStorage.getItem(LIBRARY_ASSISTANT_WIDTH_STORAGE_KEY) ?? "",
    );
    return Number.isFinite(stored)
      ? clampLibraryAssistantWidth(stored)
      : DEFAULT_LIBRARY_ASSISTANT_WIDTH;
  } catch {
    return DEFAULT_LIBRARY_ASSISTANT_WIDTH;
  }
}

function getLibraryAssistantMaxWidth(bodyWidth: number): number {
  return Math.min(
    MAX_LIBRARY_ASSISTANT_WIDTH,
    Math.max(
      MIN_LIBRARY_ASSISTANT_WIDTH,
      bodyWidth -
        MIN_LIBRARY_RESULTS_WIDTH -
        LIBRARY_ASSISTANT_RESIZE_HANDLE_WIDTH,
    ),
  );
}

export function LibrarySearchWorkspace({
  papers,
  provider,
  models,
  query,
  results,
  searching,
  searched,
  reasoningEffort,
  onModelChange,
  onReasoningChange,
  onQueryChange,
  onSearch,
  onOpenHit,
  onError,
}: LibrarySearchWorkspaceProps): React.JSX.Element {
  const readyPapers = useMemo(
    () => papers.filter((paper) => paper.status === "ready"),
    [papers],
  );
  const paperById = useMemo(
    () => new Map(papers.map((paper) => [paper.id, paper])),
    [papers],
  );
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [assistantWidth, setAssistantWidth] = useState(
    readStoredAssistantWidth,
  );
  const [resizingAssistant, setResizingAssistant] = useState(false);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<LibraryChatTurn[]>(readStoredChatTurns);
  const [answering, setAnswering] = useState(false);
  const [activeRequestId, setActiveRequestId] = useState<string>();
  const activeRequestIdRef = useRef<string | undefined>(undefined);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuSection, setModelMenuSection] =
    useState<LibraryModelMenuSection>();
  const [selectedHitKeys, setSelectedHitKeys] = useState<Set<string>>(
    readStoredSelectedHitKeys,
  );
  const chatEndRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const persistedHistoryRef = useRef("");
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const previousResultsSignatureRef = useRef<string | undefined>(undefined);
  const resultsSignature = useMemo(
    () => results.map(libraryHitKey).join("|"),
    [results],
  );
  const selectedHits = useMemo(
    () =>
      results
        .filter((hit) => selectedHitKeys.has(libraryHitKey(hit)))
        .slice(0, MAX_LIBRARY_CONTEXT_HITS),
    [results, selectedHitKeys],
  );
  const selectableModels = useMemo(
    () =>
      [provider?.model, ...models].filter(
        (model, index, all): model is string =>
          Boolean(model?.trim()) && all.indexOf(model) === index,
      ),
    [models, provider?.model],
  );
  const reasoningLabel =
    reasoningOptions.find((option) => option.value === reasoningEffort)
      ?.label ?? "中";

  useEffect(() => {
    try {
      window.localStorage.setItem(
        LIBRARY_ASSISTANT_WIDTH_STORAGE_KEY,
        String(assistantWidth),
      );
    } catch {
      // Width persistence is optional when storage is unavailable.
    }
  }, [assistantWidth]);

  useEffect(() => {
    if (!resizingAssistant) return;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const updateSize = (event: PointerEvent): void => {
      const bodyRect = bodyRef.current?.getBoundingClientRect();
      if (!bodyRect || bodyRect.width <= LIBRARY_ASSISTANT_STACK_BREAKPOINT) {
        return;
      }
      setAssistantWidth(
        clampLibraryAssistantWidth(
          bodyRect.right - event.clientX,
          getLibraryAssistantMaxWidth(bodyRect.width),
        ),
      );
    };
    const finishResize = (): void => setResizingAssistant(false);

    document.addEventListener("pointermove", updateSize);
    document.addEventListener("pointerup", finishResize);
    document.addEventListener("pointercancel", finishResize);
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      document.removeEventListener("pointermove", updateSize);
      document.removeEventListener("pointerup", finishResize);
      document.removeEventListener("pointercancel", finishResize);
    };
  }, [resizingAssistant]);

  useEffect(() => {
    const keepWidthInBounds = (): void => {
      const bodyWidth = bodyRef.current?.getBoundingClientRect().width;
      if (!bodyWidth || bodyWidth <= LIBRARY_ASSISTANT_STACK_BREAKPOINT) return;
      setAssistantWidth((current) =>
        clampLibraryAssistantWidth(
          current,
          getLibraryAssistantMaxWidth(bodyWidth),
        ),
      );
    };
    const frame = window.requestAnimationFrame(keepWidthInBounds);
    window.addEventListener("resize", keepWidthInBounds);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", keepWidthInBounds);
    };
  }, []);

  useEffect(() => {
    const completed = turns.filter((turn) => turn.answer || turn.error);
    const signature = `${completed.length}:${completed.at(-1)?.id ?? ""}`;
    if (persistedHistoryRef.current === signature) return;
    try {
      window.sessionStorage.setItem(
        LIBRARY_CHAT_STORAGE_KEY,
        JSON.stringify(completed),
      );
      persistedHistoryRef.current = signature;
    } catch {
      // Keep the complete in-memory conversation if browser storage is full.
    }
  }, [turns]);

  useEffect(() => {
    window.sessionStorage.setItem(
      LIBRARY_SELECTED_HITS_STORAGE_KEY,
      JSON.stringify([...selectedHitKeys]),
    );
  }, [selectedHitKeys]);

  useEffect(() => {
    const previousSignature = previousResultsSignatureRef.current;
    if (
      previousSignature !== undefined &&
      previousSignature !== resultsSignature
    ) {
      setSelectedHitKeys(new Set());
    }
    previousResultsSignatureRef.current = resultsSignature;
  }, [resultsSignature]);

  useEffect(() => {
    if (!assistantOpen || !followOutputRef.current) return;
    chatEndRef.current?.scrollIntoView({ block: "end" });
  }, [assistantOpen, answering, turns]);

  useEffect(() => {
    let updates: ChatProgress[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requestId: string | undefined;
    let sequence = -1;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      const batch = updates;
      updates = [];
      if (!batch.length) return;
      setTurns((current) =>
        current.map((turn) => {
          if (turn.answer || turn.error) return turn;
          let next = turn;
          for (const progress of batch) {
            if (next.requestId !== progress.requestId) continue;
            next = {
              ...next,
              streamingContent:
                progress.answerContent !== undefined
                  ? progress.answerContent
                  : (next.streamingContent ?? "") +
                    (progress.answerDelta ?? ""),
              detail: progress.detail || next.detail,
              reasoningObserved:
                progress.reasoningObserved ?? next.reasoningObserved,
              contextUsage: progress.contextUsage ?? next.contextUsage,
            };
          }
          return next;
        }),
      );
    };
    const disposeProgress = window.paperxcel.search.onProgress((progress) => {
      if (
        !progress.requestId ||
        progress.requestId !== activeRequestIdRef.current
      ) {
        return;
      }
      if (requestId !== progress.requestId) {
        requestId = progress.requestId;
        sequence = -1;
      }
      if (progress.sequence !== undefined) {
        if (progress.sequence <= sequence) return;
        sequence = progress.sequence;
      }
      updates.push(progress);
      if (!timer) timer = setTimeout(flush, 40);
    });
    const disposeAgent = window.paperxcel.search.onAgentEvent((event) => {
      if (event.requestId !== activeRequestIdRef.current) return;
      flush();
      setTurns((current) =>
        current.map((turn) =>
          turn.requestId === event.requestId
            ? {
                ...turn,
                agentEvents: [
                  ...(turn.agentEvents ?? []).filter(
                    (item) => item.sequence !== event.sequence,
                  ),
                  event,
                ]
                  .sort((a, b) => a.sequence - b.sequence)
                  .slice(-256),
              }
            : turn,
        ),
      );
    });
    return () => {
      disposeProgress();
      disposeAgent();
      if (timer) clearTimeout(timer);
      const active = activeRequestIdRef.current;
      if (active)
        void window.paperxcel.search
          .cancelAskLibrary(active)
          .catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const closeModelMenu = (event: PointerEvent): void => {
      if (!modelMenuRef.current?.contains(event.target as Node)) {
        setModelMenuOpen(false);
        setModelMenuSection(undefined);
      }
    };
    document.addEventListener("pointerdown", closeModelMenu);
    return () => document.removeEventListener("pointerdown", closeModelMenu);
  }, [modelMenuOpen]);

  const openAssistant = (): void => {
    setAssistantOpen(true);
    if (!question.trim() && query.trim()) {
      setQuestion(query.trim());
    }
    window.setTimeout(() => questionRef.current?.focus(), 0);
  };

  const startAssistantResize = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    const bodyWidth = bodyRef.current?.getBoundingClientRect().width;
    if (
      event.button !== 0 ||
      (bodyWidth !== undefined &&
        bodyWidth <= LIBRARY_ASSISTANT_STACK_BREAKPOINT)
    ) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setResizingAssistant(true);
  };

  const resizeAssistantWithKeyboard = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const bodyWidth = bodyRef.current?.getBoundingClientRect().width;
    const maxWidth = bodyWidth
      ? getLibraryAssistantMaxWidth(bodyWidth)
      : MAX_LIBRARY_ASSISTANT_WIDTH;
    const amount = event.shiftKey ? 40 : 20;
    setAssistantWidth((current) =>
      clampLibraryAssistantWidth(
        current + (event.key === "ArrowLeft" ? amount : -amount),
        maxWidth,
      ),
    );
  };

  const toggleHit = (hit: LibrarySearchHit): void => {
    const key = libraryHitKey(hit);
    setSelectedHitKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else if (next.size < MAX_LIBRARY_CONTEXT_HITS) {
        next.add(key);
      }
      return next;
    });
  };

  const selectAllResults = (): void => {
    setSelectedHitKeys(
      new Set(results.slice(0, MAX_LIBRARY_CONTEXT_HITS).map(libraryHitKey)),
    );
  };

  const changeLibraryModel = async (model: string): Promise<void> => {
    setModelMenuOpen(false);
    setModelMenuSection(undefined);
    if (model === provider?.model) return;
    try {
      await onModelChange(model);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  const askLibrary = async (): Promise<void> => {
    const cleanQuestion = question.trim();
    if (
      !cleanQuestion ||
      activeRequestIdRef.current ||
      answering ||
      !provider?.hasApiKey
    ) {
      return;
    }

    const history: LibraryAskHistoryMessage[] = turns
      .filter((turn) => turn.answer && !turn.answer.cancelled)
      .flatMap((turn) => [
        { role: "user" as const, content: turn.question },
        {
          role: "assistant" as const,
          content: turn.answer!.content,
          contextCheckpoint: turn.answer!.contextCheckpoint,
          citations: turn.answer!.citations,
        },
      ]);
    const turnId =
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const pendingTurn: LibraryChatTurn = {
      id: turnId,
      question: cleanQuestion,
      selectedCount: selectedHits.length,
      requestId: turnId,
    };

    setQuestion("");
    setModelMenuOpen(false);
    setModelMenuSection(undefined);
    setAnswering(true);
    followOutputRef.current = true;
    setActiveRequestId(turnId);
    activeRequestIdRef.current = turnId;
    setTurns((current) => [...current, pendingTurn]);
    try {
      const answer = await window.paperxcel.search.askLibrary({
        requestId: turnId,
        query: cleanQuestion,
        reasoningEffort,
        selectedHits: selectedHits.length ? selectedHits : undefined,
        history,
      });
      setTurns((current) =>
        current.map((turn) =>
          turn.id === turnId
            ? {
                ...turn,
                answer,
                streamingContent: undefined,
                contextUsage: answer.contextUsage ?? turn.contextUsage,
              }
            : turn,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTurns((current) =>
        current.map((turn) =>
          turn.id === turnId ? { ...turn, error: message } : turn,
        ),
      );
      onError(message);
    } finally {
      setAnswering(false);
      if (activeRequestIdRef.current === turnId) {
        activeRequestIdRef.current = undefined;
        setActiveRequestId(undefined);
      }
    }
  };

  const updateQuery = (value: string): void => {
    onQueryChange(value);
  };

  return (
    <section
      className={`library-search-workspace${
        resizingAssistant ? " is-resizing" : ""
      }`}
    >
      <header className="library-search-header">
        <div className="library-search-heading">
          <span className="library-search-heading-icon">
            <FileSearch size={18} />
          </span>
          <div>
            <h2>全库检索</h2>
            <p>
              本地混合检索 · {readyPapers.length}{" "}
              篇已索引（含已归档）为了检索准确性，尽可能先用文件修复功能修复自动识别的
              Markdown 文件，否则结果有可能有误
            </p>
          </div>
        </div>
        <button
          className="icon-button library-search-assistant-toggle"
          type="button"
          title={assistantOpen ? "收起全库助手" : "打开全库助手"}
          aria-label={assistantOpen ? "收起全库助手" : "打开全库助手"}
          aria-pressed={assistantOpen}
          onClick={() => {
            if (assistantOpen) {
              setAssistantOpen(false);
            } else {
              openAssistant();
            }
          }}
        >
          {assistantOpen ? (
            <PanelRightClose size={18} />
          ) : (
            <PanelRightOpen size={18} />
          )}
        </button>
      </header>

      <div
        ref={bodyRef}
        className={`library-search-body ${
          assistantOpen ? "has-assistant" : ""
        }`}
        style={
          {
            "--library-search-assistant-width": `${assistantWidth}px`,
          } as CSSProperties
        }
      >
        <div className="library-search-main">
          <form
            className="library-search-controls"
            onSubmit={(event) => {
              event.preventDefault();
              onSearch();
            }}
          >
            <label className="library-search-field">
              <Search size={18} />
              <input
                aria-label="全库检索问题"
                maxLength={500}
                placeholder="检索问题、方法、数据、结果或局限"
                value={query}
                onChange={(event) => updateQuery(event.target.value)}
              />
              <button
                type="submit"
                disabled={!query.trim() || searching || !readyPapers.length}
              >
                {searching ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Search size={16} />
                )}
                {searching ? "检索中" : "检索"}
              </button>
            </label>
          </form>

          <div className="library-search-results">
            <header className="library-search-results-header">
              <strong>检索结果</strong>
              <span className="library-search-results-tools">
                <span>
                  {searched
                    ? `${results.length} 条 · 已选 ${selectedHits.length}`
                    : "未检索"}
                </span>
                {results.length > 0 && (
                  <>
                    <button
                      type="button"
                      disabled={
                        selectedHits.length ===
                        Math.min(results.length, MAX_LIBRARY_CONTEXT_HITS)
                      }
                      onClick={selectAllResults}
                    >
                      全选
                    </button>
                    <button
                      type="button"
                      disabled={!selectedHits.length}
                      onClick={() => setSelectedHitKeys(new Set())}
                    >
                      清空
                    </button>
                  </>
                )}
              </span>
            </header>

            <div className="library-search-result-list">
              {!readyPapers.length ? (
                <div className="library-search-empty">
                  <FileSearch size={28} />
                  <strong>暂无已索引文献</strong>
                </div>
              ) : searching && !results.length ? (
                <div className="library-search-empty">
                  <LoaderCircle className="spin" size={25} />
                  <strong>正在检索</strong>
                </div>
              ) : !searched ? (
                <div className="library-search-empty">
                  <Search size={28} />
                  <strong>尚未检索</strong>
                </div>
              ) : !results.length ? (
                <div className="library-search-empty">
                  <FileSearch size={28} />
                  <strong>未找到相关内容</strong>
                </div>
              ) : (
                results.map((hit) => {
                  const paper = paperById.get(hit.paperId);
                  if (!paper) return null;
                  const selected = selectedHitKeys.has(libraryHitKey(hit));
                  // 索引切片保留了来源页码。打开来源由 App 切换论文，
                  // 再让 PDF.js 定位到命中的页面。
                  return (
                    <article
                      className={`library-search-hit ${
                        selected ? "is-selected" : ""
                      }`}
                      key={`${hit.paperId}-${hit.chunkId}`}
                    >
                      <button
                        className="library-search-hit-open"
                        type="button"
                        title={`打开第 ${hit.page} 页`}
                        onClick={() => onOpenHit(hit.paperId, hit.page)}
                      >
                        <span className="library-search-hit-source">
                          <span className="library-search-hit-page">
                            p.{hit.page}
                          </span>
                          <span className="library-search-hit-paper">
                            <strong>{paper.title}</strong>
                            <small>
                              {paper.authors.slice(0, 3).join(", ") ||
                                "作者待补全"}
                              {paper.year ? ` · ${paper.year}` : ""}
                            </small>
                          </span>
                          <ArrowUpRight size={16} />
                        </span>
                        <span className="library-search-hit-text">
                          {/* hit.text 是 SQLite chunks.text 的原始切片。AI
                        修复后的来源可能含 Markdown 标记，结果卡保持纯文本。 */}
                          {hit.text}
                        </span>
                      </button>
                      <button
                        className="library-search-hit-select"
                        type="button"
                        title={selected ? "从 AI 上下文移除" : "加入 AI 上下文"}
                        aria-label={
                          selected ? "从 AI 上下文移除" : "加入 AI 上下文"
                        }
                        aria-pressed={selected}
                        onClick={() => toggleHit(hit)}
                      >
                        {selected ? <Check size={16} /> : <Plus size={16} />}
                      </button>
                    </article>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {assistantOpen && (
          <>
            <div
              className="panel-resize-handle library-search-assistant-resize-handle"
              role="separator"
              aria-label="调整全库助手宽度"
              aria-orientation="vertical"
              aria-valuemin={MIN_LIBRARY_ASSISTANT_WIDTH}
              aria-valuemax={MAX_LIBRARY_ASSISTANT_WIDTH}
              aria-valuenow={assistantWidth}
              tabIndex={0}
              title="拖拽调整全库助手宽度，双击恢复默认"
              onPointerDown={startAssistantResize}
              onKeyDown={resizeAssistantWithKeyboard}
              onDoubleClick={() => {
                const bodyWidth =
                  bodyRef.current?.getBoundingClientRect().width;
                setAssistantWidth(
                  clampLibraryAssistantWidth(
                    DEFAULT_LIBRARY_ASSISTANT_WIDTH,
                    bodyWidth
                      ? getLibraryAssistantMaxWidth(bodyWidth)
                      : MAX_LIBRARY_ASSISTANT_WIDTH,
                  ),
                );
              }}
            />
            <aside className="ai-pane library-search-assistant">
              <header className="ai-header">
                <div className="ai-title">
                  <span className="ai-icon">
                    <Sparkles size={17} />
                  </span>
                  <div>
                    <strong>全库助手</strong>
                    <small>
                      {provider
                        ? `${provider.name} · ${provider.model}`
                        : "尚未配置模型"}
                    </small>
                    <small>273K 上下文 · 自动压缩</small>
                  </div>
                </div>
                <div className="ai-header-actions">
                  {answering && activeRequestId && (
                    <button
                      className="icon-button"
                      type="button"
                      title="停止生成"
                      aria-label="停止生成"
                      onClick={() => {
                        const requestId = activeRequestIdRef.current;
                        if (requestId) {
                          void window.paperxcel.search.cancelAskLibrary(
                            requestId,
                          );
                        }
                      }}
                    >
                      <span style={{ fontSize: 12 }}>停止</span>
                    </button>
                  )}
                  <button
                    className="icon-button"
                    type="button"
                    title="清空对话"
                    aria-label="清空对话"
                    disabled={answering || !turns.length}
                    onClick={() => setTurns([])}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </header>

              <div className="assistant-view-panel">
                <div
                  className="chat-scroll"
                  onScroll={(event) => {
                    const view = event.currentTarget;
                    followOutputRef.current =
                      view.scrollHeight - view.scrollTop - view.clientHeight <
                      100;
                  }}
                >
                  {!turns.length && (
                    <div className="chat-start library-search-chat-start">
                      <div className="chat-start-heading">
                        <Sparkles size={21} />
                        <span>直接提问，自动检索整个文献库</span>
                      </div>
                      <p>也可固定左侧证据一起分析</p>
                    </div>
                  )}
                  {turns.map((turn) => (
                    <div className="library-search-chat-turn" key={turn.id}>
                      <article className="message message-user">
                        <div className="message-content">
                          <div className="message-user-prompt">
                            {turn.question}
                          </div>
                          <small className="library-search-message-context">
                            {turn.selectedCount
                              ? `已固定 ${turn.selectedCount} 条索引片段`
                              : "全库研究"}
                          </small>
                        </div>
                      </article>
                      <article className="message message-assistant">
                        <div className="message-label library-search-message-label">
                          <Sparkles size={14} />
                          <span>PaperXcel</span>
                          <small>
                            {turn.answer?.model ??
                              (turn.error ? "请求失败" : "正在处理任务")}
                          </small>
                        </div>
                        {turn.agentEvents && (
                          <>
                            <PaperResearchPlanView events={turn.agentEvents} />
                            <AgentCommentaryView
                              events={turn.agentEvents}
                              live={!turn.answer && !turn.error}
                            />
                            <AgentExecutionTrace
                              events={turn.agentEvents}
                              live={!turn.answer && !turn.error}
                            />
                          </>
                        )}
                        {!turn.answer && !turn.error && (
                          <small role="status">
                            {turn.detail || "正在等待模型响应"}
                          </small>
                        )}
                        {turn.reasoningObserved && (
                          <small className="chat-reasoning-observed">
                            已收到模型推理信号
                          </small>
                        )}
                        {turn.answer?.cancelled && (
                          <small role="status">
                            已停止生成，已接收内容保留。
                          </small>
                        )}
                        {turn.contextUsage && (
                          <small className="chat-context-usage">
                            {Math.ceil(turn.contextUsage.inputTokens / 1000)}K /
                            273K
                            {turn.contextUsage.compactions
                              ? ` · 已压缩 ${turn.contextUsage.compactions} 次`
                              : ""}
                          </small>
                        )}
                        {turn.answer ? (
                          <>
                            <div className="message-content knowledge-markdown">
                              <ChatMarkdown content={turn.answer.content} />
                            </div>
                            {turn.answer.citationVerification?.status ===
                            "unverified" ? (
                              <div
                                className="citation-verification-warning"
                                role="status"
                              >
                                <CircleAlert size={14} />
                                <span>
                                  {turn.answer.citationVerification.detail}
                                </span>
                              </div>
                            ) : null}
                            {turn.answer.citations.length > 0 && (
                              <div className="library-search-answer-citations">
                                {turn.answer.citations.map(
                                  (citation, index) => {
                                    const paper = paperById.get(
                                      citation.paperId,
                                    );
                                    return (
                                      <button
                                        type="button"
                                        key={`${turn.id}-${citation.paperLabel}-${citation.page}-${index}`}
                                        title={`打开 ${citation.paperLabel} 第 ${citation.page} 页`}
                                        onClick={() =>
                                          onOpenHit(
                                            citation.paperId,
                                            citation.page,
                                          )
                                        }
                                      >
                                        <span>
                                          {citation.paperLabel} · p.
                                          {citation.page}
                                        </span>
                                        <strong>
                                          {paper?.title ?? "已移除文献"}
                                        </strong>
                                        <ArrowUpRight size={14} />
                                      </button>
                                    );
                                  },
                                )}
                              </div>
                            )}
                          </>
                        ) : turn.error ? (
                          <div className="message-content">
                            {turn.streamingContent && (
                              <ChatMarkdown content={turn.streamingContent} />
                            )}
                            <p className="library-search-chat-error">
                              {turn.error}
                            </p>
                          </div>
                        ) : turn.streamingContent ? (
                          <div className="message-content knowledge-markdown">
                            <ChatMarkdown content={turn.streamingContent} />
                          </div>
                        ) : (
                          <div className="message-content pending-message">
                            <div className="pending-status">
                              <LoaderCircle className="spin" size={17} />
                              <span>{turn.detail || "正在等待模型响应"}</span>
                            </div>
                          </div>
                        )}
                      </article>
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>

                <form
                  className="composer library-search-chat-composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void askLibrary();
                  }}
                >
                  <div className="composer-context">
                    <span>
                      {selectedHits.length
                        ? `已固定 ${selectedHits.length}/${Math.min(
                            results.length || MAX_LIBRARY_CONTEXT_HITS,
                            MAX_LIBRARY_CONTEXT_HITS,
                          )} 条证据`
                        : "未固定证据，将自动检索全库"}
                    </span>
                    <span className="library-search-token-warning">
                      <CircleAlert size={13} />
                      固定证据会额外消耗 token
                    </span>
                  </div>
                  <div className="composer-box">
                    <textarea
                      ref={questionRef}
                      aria-label="向全库助手提问"
                      rows={3}
                      placeholder="直接提问会自动检索全部已索引论文，也可固定证据"
                      value={question}
                      onChange={(event) => setQuestion(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          !event.shiftKey &&
                          !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault();
                          void askLibrary();
                        }
                      }}
                    />
                    <div className="composer-actions">
                      <div className="composer-model-picker" ref={modelMenuRef}>
                        <button
                          className="composer-model-trigger"
                          type="button"
                          title="选择模型和推理强度"
                          disabled={!provider || answering}
                          aria-haspopup="menu"
                          aria-expanded={modelMenuOpen}
                          onClick={() => {
                            if (modelMenuOpen) {
                              setModelMenuOpen(false);
                              setModelMenuSection(undefined);
                            } else {
                              setModelMenuOpen(true);
                            }
                          }}
                        >
                          <span className="composer-model-trigger-model">
                            {provider?.model ?? "未配置模型"}
                          </span>
                          <span className="composer-model-trigger-reasoning">
                            {reasoningLabel}
                          </span>
                          <ChevronDown size={16} />
                        </button>
                        {modelMenuOpen && (
                          <div
                            className="composer-model-popover library-search-model-popover"
                            role="menu"
                            aria-label="模型设置"
                          >
                            <button
                              className="composer-model-popover-title"
                              type="button"
                              onClick={() => {
                                setModelMenuOpen(false);
                                setModelMenuSection(undefined);
                              }}
                            >
                              <span>高级</span>
                              <ChevronUp size={15} />
                            </button>
                            <div className="composer-model-popover-divider" />
                            <button
                              className={`composer-model-row ${
                                modelMenuSection === "model" ? "active" : ""
                              }`}
                              type="button"
                              role="menuitem"
                              onClick={() =>
                                setModelMenuSection((current) =>
                                  current === "model" ? undefined : "model",
                                )
                              }
                            >
                              <span>模型</span>
                              <span className="composer-model-row-value">
                                {provider?.model ?? "未配置"}
                              </span>
                              <ChevronRight size={17} />
                            </button>
                            <button
                              className={`composer-model-row ${
                                modelMenuSection === "reasoning" ? "active" : ""
                              }`}
                              type="button"
                              role="menuitem"
                              onClick={() =>
                                setModelMenuSection((current) =>
                                  current === "reasoning"
                                    ? undefined
                                    : "reasoning",
                                )
                              }
                            >
                              <span>推理强度</span>
                              <span className="composer-model-row-value">
                                {reasoningLabel}
                              </span>
                              <ChevronRight size={17} />
                            </button>

                            {modelMenuSection === "model" && (
                              <div
                                className="composer-model-submenu"
                                role="menu"
                                aria-label="模型"
                              >
                                <div className="composer-model-submenu-title">
                                  模型
                                </div>
                                <div className="composer-model-option-list">
                                  {selectableModels.length ? (
                                    selectableModels.map((model) => (
                                      <button
                                        className={`composer-model-option ${
                                          model === provider?.model
                                            ? "selected"
                                            : ""
                                        }`}
                                        type="button"
                                        role="menuitemradio"
                                        aria-checked={model === provider?.model}
                                        key={model}
                                        onClick={() =>
                                          void changeLibraryModel(model)
                                        }
                                      >
                                        <span>{model}</span>
                                        {model === provider?.model && (
                                          <Check size={17} />
                                        )}
                                      </button>
                                    ))
                                  ) : (
                                    <div className="composer-model-option-empty">
                                      暂无可用模型
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}

                            {modelMenuSection === "reasoning" && (
                              <div
                                className="composer-model-submenu"
                                role="menu"
                                aria-label="推理强度"
                              >
                                <div className="composer-model-submenu-title">
                                  推理强度
                                </div>
                                <div className="composer-model-option-list">
                                  {reasoningOptions.map((option) => (
                                    <button
                                      className={`composer-model-option ${
                                        option.value === reasoningEffort
                                          ? "selected"
                                          : ""
                                      }`}
                                      type="button"
                                      role="menuitemradio"
                                      aria-checked={
                                        option.value === reasoningEffort
                                      }
                                      key={option.value}
                                      onClick={() => {
                                        onReasoningChange(option.value);
                                        setModelMenuOpen(false);
                                        setModelMenuSection(undefined);
                                      }}
                                    >
                                      <span>{option.label}</span>
                                      {option.value === reasoningEffort && (
                                        <Check size={17} />
                                      )}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      <button
                        className="send-button"
                        type="submit"
                        title="发送"
                        aria-label="发送"
                        disabled={
                          !question.trim() || answering || !provider?.hasApiKey
                        }
                      >
                        {answering ? (
                          <LoaderCircle className="spin" size={17} />
                        ) : (
                          <ArrowUp size={17} />
                        )}
                      </button>
                    </div>
                  </div>
                </form>
              </div>
            </aside>
          </>
        )}
      </div>
    </section>
  );
}
