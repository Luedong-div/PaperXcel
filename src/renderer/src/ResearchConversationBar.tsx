import { useId, useState } from "react";
import { History, Pencil, Plus, Trash2 } from "lucide-react";
import { RESEARCH_CONVERSATION_TITLE_MAX_LENGTH } from "../../shared/researchConversation";
import type {
  ResearchConversation,
  ResearchConversationSummary,
  ResearchTurn,
} from "../../shared/researchConversation";
import "./citationAnalysis.css";

interface Props {
  conversation?: ResearchConversation;
  sessions: ResearchConversationSummary[];
  turn?: ResearchTurn;
  running: boolean;
  loading: boolean;
  managing: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  onTurn: (id: string) => void;
  onRename: (title: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onDeleteTurn: (turnId: string) => Promise<void>;
  followUp?: {
    currentPaperCount: number;
    canFollowUp: boolean;
    onFollowUp: () => void;
    onReapply: () => void;
  };
}
export function ResearchConversationBar({
  conversation,
  sessions,
  turn,
  running,
  loading,
  managing,
  onOpen,
  onNew,
  onTurn,
  onRename,
  onDelete,
  onDeleteTurn,
  followUp,
}: Props) {
  const [editor, setEditor] = useState<"rename" | "delete" | "delete-turn">();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string>();
  const labelId = useId();
  const disabled = running || loading || managing;
  const closeEditor = () => {
    if (managing) return;
    setEditor(undefined);
    setError(undefined);
  };
  const submit = async () => {
    if (disabled || !conversation || !editor) return;
    setError(undefined);
    try {
      if (editor === "rename") await onRename(title.trim());
      else if (editor === "delete-turn") {
        if (!turn) return;
        await onDeleteTurn(turn.id);
      } else await onDelete();
      setEditor(undefined);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <section className="research-conversation-bar" aria-label="研究对话历史">
      <div className="research-conversation-controls">
        <History size={16} />
        <select
          aria-label="研究对话"
          value={conversation?.id ?? ""}
          disabled={disabled || Boolean(editor)}
          onChange={(event) => {
            if (event.target.value) onOpen(event.target.value);
          }}
        >
          <option value="">
            {loading ? "正在恢复研究对话…" : "新研究对话"}
          </option>
          {conversation &&
            !sessions.some((item) => item.id === conversation.id) && (
              <option value={conversation.id}>{conversation.title}</option>
            )}
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {session.title} · {session.turnCount} 轮
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={disabled || Boolean(editor)}
          onClick={onNew}
        >
          <Plus size={14} />
          新对话
        </button>
        {conversation && (
          <>
            <button
              type="button"
              title="重命名对话"
              aria-label="重命名对话"
              disabled={disabled}
              onClick={() => {
                setTitle(conversation.title);
                setError(undefined);
                setEditor("rename");
              }}
            >
              <Pencil size={15} />
            </button>
            <button
              type="button"
              title="删除对话"
              aria-label="删除对话"
              disabled={disabled}
              onClick={() => {
                setError(undefined);
                setEditor("delete");
              }}
            >
              <Trash2 size={15} />
            </button>
          </>
        )}
      </div>
      {conversation && editor && (
        <div
          className="research-conversation-editor"
          onKeyDown={(event) => {
            if (event.key === "Escape") closeEditor();
          }}
        >
          {editor === "rename" ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <label htmlFor={labelId}>对话名称</label>
              <div className="research-conversation-controls">
                <input
                  id={labelId}
                  autoFocus
                  value={title}
                  maxLength={RESEARCH_CONVERSATION_TITLE_MAX_LENGTH}
                  disabled={disabled}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setTitle(event.target.value)}
                />
                <button type="submit" disabled={disabled || !title.trim()}>
                  {managing ? "正在保存…" : "保存名称"}
                </button>
                <button type="button" disabled={managing} onClick={closeEditor}>
                  取消
                </button>
              </div>
            </form>
          ) : (
            <div role="alertdialog" aria-labelledby={labelId}>
              <p id={labelId}>
                {editor === "delete-turn"
                  ? `删除第 ${conversation.turns.findIndex((item) => item.id === turn?.id) + 1} 轮？`
                  : `删除“${conversation.title}”？`}
              </p>
              {editor === "delete-turn" ? (
                <>
                  <p>{turn?.question}</p>
                  <p>
                    将删除本轮的查询、报告和执行记录，无法撤销。
                    {conversation.turns.length === 1
                      ? "删除后保留空对话及其名称。"
                      : "其他轮次保留。"}
                  </p>
                </>
              ) : (
                <p>
                  将删除全部 {conversation.turns.length}{" "}
                  轮记录与生成结果，无法撤销。
                </p>
              )}
              <div className="research-conversation-controls">
                <button
                  type="button"
                  autoFocus
                  disabled={managing}
                  onClick={closeEditor}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="research-delete-button"
                  disabled={disabled}
                  onClick={() => void submit()}
                >
                  {managing ? "正在删除…" : "确认删除"}
                </button>
              </div>
            </div>
          )}
          {error && (
            <p className="citation-ai-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
      {conversation && (
        <>
          <div className="research-conversation-controls">
            <select
              aria-label="研究对话轮次"
              value={turn?.id ?? ""}
              disabled={
                disabled || Boolean(editor) || !conversation.turns.length
              }
              onChange={(event) => onTurn(event.target.value)}
            >
              {!turn && (
                <option value="">
                  {running ? "当前执行轮次" : "暂无轮次"}
                </option>
              )}
              {conversation.turns.map((item, index) => (
                <option key={item.id} value={item.id}>
                  第 {index + 1} 轮 · {item.question}
                </option>
              ))}
            </select>
            <button
              type="button"
              title="删除本轮"
              aria-label="删除本轮"
              disabled={disabled || !turn}
              onClick={() => {
                setError(undefined);
                setEditor("delete-turn");
              }}
            >
              <Trash2 size={14} />
              删除本轮
            </button>
            <span className="research-saved">
              {running ? "正在自动保存" : "已保存到本地"}
            </span>
          </div>
          {turn && (
            <>
              <details className="research-turn-scope">
                <summary>
                  本轮文献：{turn.scope.papers.length} 篇起点
                  {conversation.kind === "analysis"
                    ? ` · ${turn.scope.snapshot.nodes.length} 篇网络论文`
                    : ""}{" "}
                  · {new Date(turn.createdAt).toLocaleString()}
                </summary>
                <ul>
                  {turn.scope.papers.map((paper) => (
                    <li key={paper.id}>{paper.title}</li>
                  ))}
                </ul>
                <p>{turn.question}</p>
                {turn.scope.filters && (
                  <p>
                    本轮筛选：{turn.scope.filters.yearFrom ?? "不限起始年份"} —{" "}
                    {turn.scope.filters.yearTo ?? "不限结束年份"} ·{" "}
                    {turn.scope.filters.sources?.join(" / ") || "全部检索来源"}
                  </p>
                )}
              </details>
              {followUp && (
                <div className="research-conversation-actions">
                  <button
                    type="button"
                    disabled={
                      disabled || Boolean(editor) || !followUp.canFollowUp
                    }
                    onClick={followUp.onFollowUp}
                  >
                    沿用本轮文献追问
                  </button>
                  <button
                    type="button"
                    disabled={
                      disabled || Boolean(editor) || !followUp.currentPaperCount
                    }
                    onClick={followUp.onReapply}
                  >
                    将本轮问题用于当前 {followUp.currentPaperCount} 篇论文
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
