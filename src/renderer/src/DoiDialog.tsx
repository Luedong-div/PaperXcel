import { useState } from "react";
import { BookMarked, LoaderCircle, X } from "lucide-react";
import type { Paper } from "../../shared/contracts";

interface DoiDialogProps {
  open: boolean;
  onClose: () => void;
  onAdded: (paper: Paper) => void;
}

export function DoiDialog({
  open,
  onClose,
  onAdded,
}: DoiDialogProps): React.JSX.Element | null {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const paper = await window.paperxcel.papers.addFromIdentifier(input);
      onAdded(paper);
      setInput("");
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="dialog doi-dialog"
        role="dialog"
        aria-modal="true"
        onSubmit={submit}
      >
        <header className="dialog-header">
          <div>
            <h2>添加论文</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            title="关闭"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="doi-field">
          <BookMarked size={18} />
          <input
            autoFocus
            spellCheck={false}
            placeholder="请输入 DOI 等相关信息"
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
        </div>
        {loading && (
          <p className="doi-query-status">
            {looksLikeArxivIdentifier(input)
              ? "正在查询 arXiv 并获取开放 PDF…"
              : "正在查询开放来源；若弹出验证窗口，请手动完成验证…"}
          </p>
        )}
        {error && <p className="inline-error">{error}</p>}
        <footer className="dialog-footer">
          <button className="secondary-button" type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="primary-button"
            type="submit"
            disabled={!input.trim() || loading}
          >
            {loading && <LoaderCircle className="spin" size={15} />}
            添加论文
          </button>
        </footer>
      </form>
    </div>
  );
}

function looksLikeArxivIdentifier(value: string): boolean {
  const input = value.trim();
  return (
    /arxiv/i.test(input) ||
    /^\d{4}\.\d{4,5}(?:v\d+)?$/i.test(input) ||
    /^[a-z][a-z0-9.-]*\/\d{7}(?:v\d+)?$/i.test(input)
  );
}
