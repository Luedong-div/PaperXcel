import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Download,
  Eye,
  LoaderCircle,
  NotebookPen,
  PencilLine,
  Sparkles,
  Square,
} from "lucide-react";
import type { Paper, PaperNote } from "../../shared/contracts";
import { ChatMarkdown } from "./ChatMarkdown";
import { AgentExecutionTrace } from "./AgentExecutionTrace";
import { PaperTextStreamController } from "./paperTextStreamController";

interface PaperNotesProps {
  paper: Paper;
  onError: (message: string) => void;
  onContentChange?: (paperId: string, content: string) => void;
  onGeneratingChange?: (paperId: string, generating: boolean) => void;
  showGenerate?: boolean;
  emptyMessage?: string;
}

type SaveState =
  | "loading"
  | "saving"
  | "saved"
  | "generated"
  | "exported"
  | "error";
type NoteView = "edit" | "preview";
const NOTE_VIEW_STORAGE_KEY = "paperxcel:note-view";
const NOTE_PLACEHOLDER = `## 研究问题\n\n## 理论框架\n\n## 方法与关键近似\n\n## 计算设置与复现参数\n\n## 主要结果与证据链\n\n## 局限性\n\n## 待核查问题`;

export function PaperNotes({
  paper,
  onError,
  onContentChange,
  onGeneratingChange,
  showGenerate = true,
  emptyMessage,
}: PaperNotesProps): React.JSX.Element {
  const [content, setContent] = useState("");
  const [view, setView] = useState<NoteView>(readStoredNoteView);
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [generating, setGenerating] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  const [showDraft, setShowDraft] = useState(false);
  const [streamStore] = useState(() => new PaperTextStreamController());
  const activeRequestIdRef = useRef<string | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const draftRef = useRef("");
  const savedRef = useRef("");
  const loadedRef = useRef(false);
  const aliveRef = useRef(true);
  const saveQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));

  useEffect(() => {
    let disposed = false;
    aliveRef.current = true;
    loadedRef.current = false;
    setSaveState("loading");
    setHasDraft(false);
    setShowDraft(false);
    streamStore.clear(paper.id);
    void Promise.all([
      window.paperxcel.notes.get(paper.id),
      window.paperxcel.notes.getDraft?.(paper.id) ?? Promise.resolve(null),
    ])
      .then(([note, generatedDraft]) => {
        if (disposed) return;
        const next = note?.content ?? "";
        draftRef.current = next;
        savedRef.current = next;
        loadedRef.current = true;
        setContent(next);
        onContentChange?.(paper.id, next);
        setSaveState("saved");
        if (generatedDraft) {
          streamStore.restore(
            paper.id,
            {
              content: generatedDraft.content,
              phase: "streaming",
              completed: 0,
              total: 0,
            },
            generatedDraft.generationStatus === "error"
              ? "error"
              : "interrupted",
          );
          setHasDraft(true);
          setShowDraft(true);
        }
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setSaveState("error");
        onError(errorMessage(error));
      });
    return () => {
      disposed = true;
      aliveRef.current = false;
      const requestId = activeRequestIdRef.current;
      activeRequestIdRef.current = undefined;
      streamStore.clear();
      if (requestId) {
        void window.paperxcel.notes.cancel(requestId).catch(() => undefined);
        onGeneratingChange?.(paper.id, false);
      }
      if (timerRef.current) clearTimeout(timerRef.current);
      if (loadedRef.current && draftRef.current !== savedRef.current) {
        const finalContent = draftRef.current;
        void saveQueueRef.current
          .then(() => window.paperxcel.notes.save(paper.id, finalContent))
          .catch(() => undefined);
      }
    };
  }, [onContentChange, onError, onGeneratingChange, paper.id, streamStore]);

  useEffect(() => {
    const offProgress = window.paperxcel.notes.onProgress?.(
      streamStore.receive,
    );
    const offAgent = window.paperxcel.notes.onAgentEvent(
      streamStore.receiveAgent,
    );
    return () => {
      offProgress?.();
      offAgent();
    };
  }, [streamStore]);

  useEffect(() => {
    try {
      window.localStorage.setItem(NOTE_VIEW_STORAGE_KEY, view);
    } catch {
      /* View switching also works without preference storage. */
    }
  }, [view]);

  const persist = (nextContent = draftRef.current): Promise<boolean> => {
    if (!loadedRef.current || nextContent === savedRef.current)
      return Promise.resolve(true);
    if (aliveRef.current) setSaveState("saving");
    const operation = saveQueueRef.current.then(async () => {
      try {
        const note = await window.paperxcel.notes.save(paper.id, nextContent);
        savedRef.current = note.content;
        if (aliveRef.current && draftRef.current === note.content)
          setSaveState("saved");
        return true;
      } catch (error) {
        if (aliveRef.current) {
          setSaveState("error");
          onError(errorMessage(error));
        }
        return false;
      }
    });
    saveQueueRef.current = operation;
    return operation;
  };

  const updateContent = (next: string): void => {
    setContent(next);
    draftRef.current = next;
    onContentChange?.(paper.id, next);
    setSaveState("saving");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      void persist(next);
    }, 650);
  };

  const acceptSaved = (note: PaperNote): void => {
    draftRef.current = note.content;
    savedRef.current = note.content;
    setContent(note.content);
    onContentChange?.(paper.id, note.content);
    setSaveState("generated");
    setHasDraft(false);
    setShowDraft(false);
    streamStore.clear(paper.id);
  };

  const generate = async (): Promise<void> => {
    if (
      activeRequestIdRef.current ||
      generating ||
      !loadedRef.current ||
      paper.status !== "ready"
    )
      return;
    const requestId = crypto.randomUUID();
    activeRequestIdRef.current = requestId;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    if (
      !(await persist()) ||
      !aliveRef.current ||
      activeRequestIdRef.current !== requestId
    ) {
      if (activeRequestIdRef.current === requestId)
        activeRequestIdRef.current = undefined;
      return;
    }
    setGenerating(true);
    setHasDraft(true);
    setShowDraft(true);
    streamStore.start(paper.id, requestId);
    onGeneratingChange?.(paper.id, true);
    try {
      const result = await window.paperxcel.notes.generate(paper.id, requestId);
      if (!aliveRef.current || activeRequestIdRef.current !== requestId) return;
      if ("cancelled" in result) {
        streamStore.finish("interrupted", result.note?.content);
        return;
      }
      streamStore.finish("complete", result.note.content);
      acceptSaved(result.note);
      if (result.warning) onError(result.warning);
    } catch (error) {
      if (!aliveRef.current || activeRequestIdRef.current !== requestId) return;
      streamStore.finish("error");
      onError(errorMessage(error));
    } finally {
      if (aliveRef.current && activeRequestIdRef.current === requestId) {
        activeRequestIdRef.current = undefined;
        setGenerating(false);
        onGeneratingChange?.(paper.id, false);
      }
    }
  };

  const cancelGeneration = async (): Promise<void> => {
    const requestId = activeRequestIdRef.current;
    if (!requestId) return;
    try {
      await window.paperxcel.notes.cancel(requestId);
    } catch (error) {
      if (aliveRef.current) onError(errorMessage(error));
    }
  };

  const adoptDraft = async (): Promise<void> => {
    if (generating) return;
    const next = streamStore.getSnapshot().update?.content;
    if (!next?.trim()) return;
    try {
      const note = await window.paperxcel.notes.save(paper.id, next);
      if (aliveRef.current) acceptSaved(note);
    } catch (error) {
      if (aliveRef.current) onError(errorMessage(error));
    }
  };

  const exportMarkdown = async (): Promise<void> => {
    if (!draftRef.current.trim()) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    if (!(await persist())) return;
    try {
      if (
        (await window.paperxcel.notes.exportMarkdown(paper.id)) &&
        aliveRef.current
      )
        setSaveState("exported");
    } catch (error) {
      if (aliveRef.current) {
        setSaveState("error");
        onError(errorMessage(error));
      }
    }
  };

  return (
    <section className="notes-workspace">
      <header className="notes-toolbar">
        <div className="notes-status">
          <NotebookPen size={15} />
          <span>{generating ? "正在生成草稿" : saveStateLabel(saveState)}</span>
        </div>
        <div className="notes-actions">
          <div className="note-view-toggle" role="group" aria-label="笔记视图">
            <button
              className={view === "edit" ? "active" : ""}
              type="button"
              aria-pressed={view === "edit"}
              onClick={() => setView("edit")}
            >
              <PencilLine size={13} />
              编辑
            </button>
            <button
              className={view === "preview" ? "active" : ""}
              type="button"
              aria-pressed={view === "preview"}
              onClick={() => setView("preview")}
            >
              <Eye size={13} />
              预览
            </button>
          </div>
          <button
            className="icon-button"
            type="button"
            title="导出 Markdown"
            disabled={!content.trim() || generating || showDraft}
            onClick={() => void exportMarkdown()}
          >
            <Download size={16} />
          </button>
          {showGenerate && (
            <button
              className="note-generate-button"
              type="button"
              disabled={
                !generating &&
                (paper.status !== "ready" || saveState === "loading")
              }
              onClick={() =>
                void (generating ? cancelGeneration() : generate())
              }
            >
              {generating ? <Square size={13} /> : <Sparkles size={15} />}
              {generating ? "停止生成" : "AI 生成"}
            </button>
          )}
        </div>
      </header>
      {hasDraft && (
        <div className="note-draft-tabs" role="group" aria-label="笔记版本">
          <button
            type="button"
            aria-pressed={!showDraft}
            onClick={() => setShowDraft(false)}
          >
            已保存笔记
          </button>
          <button
            type="button"
            aria-pressed={showDraft}
            onClick={() => setShowDraft(true)}
          >
            生成草稿
          </button>
        </div>
      )}
      {showDraft ? (
        <NoteGenerationView
          store={streamStore}
          paperId={paper.id}
          onAdopt={() => void adoptDraft()}
        />
      ) : view === "edit" ? (
        <textarea
          className="note-editor"
          aria-label="阅读笔记"
          placeholder={emptyMessage ?? NOTE_PLACEHOLDER}
          disabled={saveState === "loading" || generating}
          value={content}
          onChange={(event) => updateContent(event.target.value)}
          onBlur={() => void persist()}
          spellCheck
        />
      ) : (
        <div className="note-preview" aria-label="阅读笔记预览">
          {content.trim() ? (
            <ChatMarkdown content={content} />
          ) : (
            <p className="note-preview-empty">
              {emptyMessage ?? "还没有可预览的笔记。"}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function NoteGenerationView({
  store,
  paperId,
  onAdopt,
}: {
  store: PaperTextStreamController;
  paperId: string;
  onAdopt: () => void;
}): React.JSX.Element | null {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (snapshot.paperId !== paperId) return null;
  const { update, status } = snapshot;
  const running = status === "running";
  return (
    <div className="note-generation-draft">
      <div className="paper-text-progress-status" role="status">
        {running && (
          <LoaderCircle className="spin" size={14} aria-hidden="true" />
        )}
        <strong>
          {running
            ? "正在生成笔记"
            : status === "complete"
              ? "笔记已生成"
              : status === "error"
                ? "生成中断 · 草稿已保留"
                : "已停止 · 草稿已保留"}
        </strong>
        {Boolean(update?.total) && (
          <span>
            已完成 {update?.completed}/{update?.total}
          </span>
        )}
      </div>
      {update?.detail && (
        <p className="note-generation-detail">{update.detail}</p>
      )}
      <AgentExecutionTrace events={snapshot.events} live={running} />
      {!running && update?.content.trim() && (
        <button
          type="button"
          className="secondary-button note-adopt-draft"
          onClick={onAdopt}
        >
          采用草稿并编辑
        </button>
      )}
      <div className="note-preview" aria-label="笔记生成草稿">
        {update?.content ? (
          <ChatMarkdown content={update.content} />
        ) : (
          <p className="note-preview-empty">等待模型返回笔记内容…</p>
        )}
      </div>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function saveStateLabel(state: SaveState): string {
  if (state === "loading") return "加载中";
  if (state === "saving") return "正在保存";
  if (state === "generated") return "AI 笔记已保存";
  if (state === "exported") return "Markdown 已导出";
  if (state === "error") return "保存失败";
  return "已保存";
}
function readStoredNoteView(): NoteView {
  try {
    return window.localStorage.getItem(NOTE_VIEW_STORAGE_KEY) === "preview"
      ? "preview"
      : "edit";
  } catch {
    return "edit";
  }
}
