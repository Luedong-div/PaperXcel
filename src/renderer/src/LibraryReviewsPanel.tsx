import { useEffect, useRef, useState } from "react";
import {
  Download,
  FileText,
  LoaderCircle,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import type { AgentEvent, LibraryReview } from "../../shared/contracts";
import { ChatMarkdown } from "./ChatMarkdown";

interface LibraryReviewsPanelProps {
  onError: (message: string) => void;
}

export function LibraryReviewsPanel({
  onError,
}: LibraryReviewsPanelProps): React.JSX.Element {
  const [reviews, setReviews] = useState<LibraryReview[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [focus, setFocus] = useState("");
  const [generating, setGenerating] = useState(false);
  const [streamContent, setStreamContent] = useState("");
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const activeRequestRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    void window.paperxcel.reviews
      .list()
      .then((items) => {
        setReviews(items);
        setSelectedId((current) => current ?? items[0]?.id);
      })
      .catch((error: unknown) =>
        onError(error instanceof Error ? error.message : String(error)),
      );
  }, [onError]);

  useEffect(
    () =>
      window.paperxcel.reviews.onAgentEvent((event) => {
        if (event.requestId !== activeRequestRef.current) return;
        if (
          event.type === "content.snapshot" &&
          typeof event.metadata?.content === "string"
        ) {
          setStreamContent(event.metadata.content);
          return;
        }
        if (event.type === "content.delta" && event.delta) {
          setStreamContent((current) => current + event.delta);
          return;
        }
        if (event.type !== "progress.updated") {
          setAgentEvents((current) => [...current, event].slice(-10));
        } else if (event.detail) {
          setAgentEvents((current) => [...current, event].slice(-10));
        }
      }),
    [],
  );

  const generate = async (): Promise<void> => {
    if (generating) return;
    const requestId = crypto.randomUUID();
    activeRequestRef.current = requestId;
    setGenerating(true);
    setStreamContent("");
    setAgentEvents([]);
    try {
      const result = await window.paperxcel.reviews.generate({
        focus,
        requestId,
      });
      if ("cancelled" in result) return;
      setReviews((current) => [result, ...current]);
      setSelectedId(result.id);
      setStreamContent("");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      activeRequestRef.current = undefined;
      setGenerating(false);
    }
  };

  const cancel = async (): Promise<void> => {
    const requestId = activeRequestRef.current;
    if (requestId) await window.paperxcel.reviews.cancel(requestId);
  };

  const remove = async (reviewId: string): Promise<void> => {
    await window.paperxcel.reviews.remove(reviewId);
    setReviews((current) => current.filter((item) => item.id !== reviewId));
    setSelectedId((current) =>
      current === reviewId
        ? reviews.find((item) => item.id !== reviewId)?.id
        : current,
    );
  };

  const selected = reviews.find((review) => review.id === selectedId);
  const visibleContent = generating ? streamContent : selected?.content;

  return (
    <div className="library-reviews-workspace">
      <aside className="library-review-sidebar">
        <div className="library-review-create">
          <label htmlFor="library-review-focus">综述研究焦点</label>
          <textarea
            id="library-review-focus"
            value={focus}
            onChange={(event) => setFocus(event.target.value)}
            placeholder="例如：比较不同方法、数据集、结论分歧与研究空白"
            disabled={generating}
          />
          <button
            className="primary-button"
            type="button"
            onClick={() => void (generating ? cancel() : generate())}
          >
            {generating ? <Square size={13} /> : <Sparkles size={15} />}
            {generating ? "停止生成" : "生成全库综述"}
          </button>
        </div>
        <div className="library-review-list">
          {reviews.map((review) => (
            <button
              className={review.id === selectedId ? "selected" : ""}
              type="button"
              key={review.id}
              onClick={() => setSelectedId(review.id)}
            >
              <strong>{review.focus || "综合文献综述"}</strong>
              <small>
                {review.paperIds.length} 篇 ·{" "}
                {new Date(review.createdAt).toLocaleString()}
              </small>
            </button>
          ))}
        </div>
      </aside>

      <main className="library-review-document">
        {generating && agentEvents.length ? (
          <div className="library-review-agent" aria-live="polite">
            {agentEvents.map((event) => (
              <div key={`${event.requestId}-${event.sequence}`}>
                {event.status === "running" ? (
                  <LoaderCircle className="spin" size={13} />
                ) : (
                  <span className="note-agent-event-dot" />
                )}
                <span>
                  <strong>{event.title}</strong>
                  {event.detail ? <small>{event.detail}</small> : null}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {selected && !generating ? (
          <div className="library-review-actions">
            <button
              className="icon-button"
              type="button"
              title="导出综述 Markdown"
              onClick={() =>
                void window.paperxcel.reviews.exportMarkdown(selected.id)
              }
            >
              <Download size={15} />
            </button>
            <button
              className="icon-button danger"
              type="button"
              title="删除综述"
              onClick={() => void remove(selected.id)}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ) : null}
        {visibleContent?.trim() ? (
          <article className="knowledge-markdown">
            <ChatMarkdown content={visibleContent} />
          </article>
        ) : (
          <div className="knowledge-empty">
            <FileText size={24} />
            <strong>
              {generating ? "正在组织综述正文" : "还没有全库综述"}
            </strong>
            <span>
              {generating
                ? "模型返回正文后会在这里实时显示"
                : "输入研究焦点后，Agent 会分组分析全部论文笔记和引用关系"}
            </span>
          </div>
        )}
      </main>
    </div>
  );
}
