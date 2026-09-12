import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  Database,
  FileText,
  NotebookPen,
  Search,
  Sparkles,
} from "lucide-react";
import type { Paper } from "../../shared/contracts";
import { PaperNotes } from "./PaperNotes";
import { LibraryReviewsPanel } from "./LibraryReviewsPanel";

interface KnowledgeWorkspaceProps {
  papers: Paper[];
  indexWidth: number;
  indexMinWidth: number;
  indexMaxWidth: number;
  onIndexResizePointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onIndexResizeKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onError: (message: string) => void;
}

export function KnowledgeWorkspace({
  papers,
  indexWidth,
  indexMinWidth,
  indexMaxWidth,
  onIndexResizePointerDown,
  onIndexResizeKeyDown,
  onError,
}: KnowledgeWorkspaceProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [noteContents, setNoteContents] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | undefined>(
    papers[0]?.id,
  );
  const [mode, setMode] = useState<"notes" | "reviews">("notes");

  useEffect(() => {
    let disposed = false;
    void window.paperxcel.notes
      .list()
      .then((notes) => {
        if (disposed) return;
        const paperIds = new Set(papers.map((paper) => paper.id));
        setNoteContents(
          Object.fromEntries(
            notes
              .filter((note) => paperIds.has(note.paperId))
              .map((note) => [note.paperId, note.content]),
          ),
        );
      })
      .catch((error: unknown) => {
        if (!disposed) {
          onError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      disposed = true;
    };
  }, [onError, papers]);

  const handleNoteContentChange = useCallback(
    (paperId: string, content: string): void => {
      setNoteContents((current) =>
        current[paperId] === content
          ? current
          : { ...current, [paperId]: content },
      );
    },
    [],
  );

  const filteredPapers = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return papers;
    return papers.filter((paper) =>
      [
        paper.title,
        paper.authors.join(" "),
        paper.journal,
        paper.year,
        paper.doi,
        paper.fileName,
        noteContents[paper.id],
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    );
  }, [noteContents, papers, query]);

  useEffect(() => {
    if (!papers.length) {
      setSelectedId(undefined);
      return;
    }
    if (!selectedId || !papers.some((paper) => paper.id === selectedId)) {
      setSelectedId(papers[0].id);
    }
  }, [papers, selectedId]);

  useEffect(() => {
    if (
      filteredPapers.length &&
      (!selectedId || !filteredPapers.some((paper) => paper.id === selectedId))
    ) {
      setSelectedId(filteredPapers[0].id);
    }
  }, [filteredPapers, selectedId]);

  const selectedPaper = query.trim()
    ? (filteredPapers.find((paper) => paper.id === selectedId) ??
      filteredPapers[0])
    : (papers.find((paper) => paper.id === selectedId) ?? papers[0]);

  return (
    <section className="knowledge-workspace">
      <header className="knowledge-header">
        <div className="knowledge-heading">
          <span className="knowledge-heading-icon">
            <Database size={17} />
          </span>
          <div>
            <h2>知识库</h2>
            <p>{papers.length} 篇文章 · 阅读笔记与 AI 摘要</p>
          </div>
        </div>
        <span className="knowledge-header-count">
          {filteredPapers.length} / {papers.length}
        </span>
        <div className="knowledge-mode-toggle" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "notes"}
            className={mode === "notes" ? "active" : ""}
            onClick={() => setMode("notes")}
          >
            <NotebookPen size={14} />
            论文笔记
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "reviews"}
            className={mode === "reviews" ? "active" : ""}
            onClick={() => setMode("reviews")}
          >
            <Sparkles size={14} />
            全库综述
          </button>
        </div>
      </header>

      {mode === "reviews" ? (
        <LibraryReviewsPanel onError={onError} />
      ) : (
        <div className="knowledge-notes-layout">
          <aside className="knowledge-paper-index" aria-label="文章列表">
            <label className="knowledge-search">
              <Search size={14} />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索标题、作者、期刊、DOI、笔记 Markdown..."
                aria-label="搜索文章和笔记"
              />
            </label>

            <div className="knowledge-paper-list">
              {filteredPapers.length ? (
                filteredPapers.map((paper) => (
                  <button
                    key={paper.id}
                    className={`knowledge-paper-row ${
                      selectedPaper?.id === paper.id ? "selected" : ""
                    }`}
                    type="button"
                    onClick={() => setSelectedId(paper.id)}
                  >
                    <span>
                      <strong>{paper.title || "未命名文献"}</strong>
                      <small>
                        {paper.authors || "作者未录入"}
                        {paper.year ? ` · ${paper.year}` : ""}
                      </small>
                    </span>
                    <i
                      className={paper.status === "ready" ? "ready" : ""}
                      title={paperStatusLabel(paper.status)}
                    />
                  </button>
                ))
              ) : (
                <div className="knowledge-empty compact">
                  <FileText size={20} />
                  <strong>没有匹配的文章</strong>
                </div>
              )}
            </div>
          </aside>

          <div
            className="panel-resize-handle knowledge-index-resize-handle"
            role="separator"
            aria-label="调整知识库文章列表宽度"
            aria-orientation="vertical"
            aria-valuemin={indexMinWidth}
            aria-valuemax={indexMaxWidth}
            aria-valuenow={indexWidth}
            tabIndex={0}
            onPointerDown={onIndexResizePointerDown}
            onKeyDown={onIndexResizeKeyDown}
          />

          <main className="knowledge-paper-detail">
            {selectedPaper ? (
              <>
                <header className="knowledge-paper-detail-header">
                  <div>
                    <h3>{selectedPaper.title || "未命名文献"}</h3>
                    <p>{paperMeta(selectedPaper)}</p>
                  </div>
                  <span
                    className={`knowledge-paper-status ${
                      selectedPaper.status === "ready" ? "ready" : ""
                    }`}
                  >
                    {paperStatusLabel(selectedPaper.status)}
                  </span>
                </header>
                <PaperNotes
                  key={selectedPaper.id}
                  paper={selectedPaper}
                  onError={onError}
                  onContentChange={handleNoteContentChange}
                  showGenerate={false}
                  emptyMessage="本论文尚未写入任何笔记，请前往“文献库”进行编辑或生成"
                />
              </>
            ) : (
              <div className="knowledge-empty">
                <Database size={24} />
                <strong>知识库还是空的</strong>
                <span>导入文献后，可以在这里整理阅读笔记。</span>
              </div>
            )}
          </main>
        </div>
      )}
    </section>
  );
}

function paperMeta(paper: Paper): string {
  return [
    paper.authors || "作者未录入",
    paper.journal,
    paper.year,
    paper.doi ? `DOI ${paper.doi}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

function paperStatusLabel(status: Paper["status"]): string {
  if (status === "ready") return "已索引";
  if (status === "processing") return "处理中";
  if (status === "needs_file") return "待导入";
  return "索引失败";
}
