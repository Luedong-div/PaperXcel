import { BookOpenText, FileText } from "lucide-react";

export type DocumentViewMode = "pdf" | "markdown";

interface DocumentViewToggleProps {
  value: DocumentViewMode;
  onChange: (value: DocumentViewMode) => void;
}

export function DocumentViewToggle({
  value,
  onChange,
}: DocumentViewToggleProps): React.JSX.Element {
  return (
    <div
      className="document-view-toggle"
      role="tablist"
      aria-label="文献阅读格式"
    >
      <button
        className={value === "pdf" ? "active" : ""}
        type="button"
        role="tab"
        aria-selected={value === "pdf"}
        onClick={() => onChange("pdf")}
      >
        <FileText size={13} />
        PDF
      </button>
      <button
        className={value === "markdown" ? "active" : ""}
        type="button"
        role="tab"
        aria-selected={value === "markdown"}
        onClick={() => onChange("markdown")}
      >
        <BookOpenText size={13} />
        Markdown
      </button>
    </div>
  );
}
