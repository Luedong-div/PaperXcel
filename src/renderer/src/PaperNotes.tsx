import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  Download,
  Eye,
  LoaderCircle,
  NotebookPen,
  PencilLine,
  Sparkles,
} from "lucide-react";
import type { Paper } from "../../shared/contracts";
import { normalizeMarkdownMath } from "./markdown";

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

const NOTE_PLACEHOLDER = `## 研究问题

## 理论框架

## 方法与关键近似

## 计算设置与复现参数

## 主要结果与证据链

## 局限性

## 待核查问题`;

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
    void window.paperxcel.notes
      .get(paper.id)
      .then((note) => {
        if (disposed) return;
        const next = note?.content ?? "";
        draftRef.current = next;
        savedRef.current = next;
        loadedRef.current = true;
        setContent(next);
        onContentChange?.(paper.id, next);
        setSaveState("saved");
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setSaveState("error");
        onError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      disposed = true;
      aliveRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (loadedRef.current && draftRef.current !== savedRef.current) {
        const finalContent = draftRef.current;
        void saveQueueRef.current.then(
          () => window.paperxcel.notes.save(paper.id, finalContent),
          () => window.paperxcel.notes.save(paper.id, finalContent),
        );
      }
    };
  }, [onContentChange, onError, paper.id]);

  useEffect(() => {
    try {
      window.localStorage.setItem(NOTE_VIEW_STORAGE_KEY, view);
    } catch {
      // The view can still be switched when local preference storage is blocked.
    }
  }, [view]);

  const persist = (nextContent = draftRef.current): Promise<boolean> => {
    if (!loadedRef.current || nextContent === savedRef.current) {
      return Promise.resolve(true);
    }
    if (aliveRef.current) setSaveState("saving");
    const operation = saveQueueRef.current.then(async () => {
      try {
        const note = await window.paperxcel.notes.save(paper.id, nextContent);
        savedRef.current = note.content;
        if (aliveRef.current && draftRef.current === note.content) {
          setSaveState("saved");
        }
        return true;
      } catch (error) {
        if (aliveRef.current) setSaveState("error");
        onError(error instanceof Error ? error.message : String(error));
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

  const generate = async (): Promise<void> => {
    if (generating || paper.status !== "ready") return;
    if (
      draftRef.current.trim() &&
      !window.confirm("AI 生成会替换当前阅读笔记，继续吗？")
    ) {
      return;
    }
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    setGenerating(true);
    onGeneratingChange?.(paper.id, true);
    try {
      const result = await window.paperxcel.notes.generate(paper.id);
      draftRef.current = result.note.content;
      savedRef.current = result.note.content;
      setContent(result.note.content);
      onContentChange?.(paper.id, result.note.content);
      setSaveState("generated");
      if (result.warning) onError(result.warning);
    } catch (error) {
      setSaveState("error");
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setGenerating(false);
      onGeneratingChange?.(paper.id, false);
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
      if (await window.paperxcel.notes.exportMarkdown(paper.id)) {
        setSaveState("exported");
      }
    } catch (error) {
      setSaveState("error");
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section className="notes-workspace">
      <header className="notes-toolbar">
        <div className="notes-status">
          <NotebookPen size={15} />
          <span>{saveStateLabel(saveState)}</span>
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
            disabled={!content.trim() || generating}
            onClick={() => void exportMarkdown()}
          >
            <Download size={16} />
          </button>
          {showGenerate ? (
            <button
              className="note-generate-button"
              type="button"
              disabled={paper.status !== "ready" || generating}
              onClick={() => void generate()}
            >
              {generating ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Sparkles size={15} />
              )}
              {generating ? "生成中" : "AI 生成"}
            </button>
          ) : null}
        </div>
      </header>
      {view === "edit" ? (
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
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
              rehypePlugins={[rehypeKatex]}
              components={{
                a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
              }}
            >
              {normalizeMarkdownMath(content)}
            </ReactMarkdown>
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
