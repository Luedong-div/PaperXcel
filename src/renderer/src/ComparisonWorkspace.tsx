import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Columns3,
  Download,
  FileSearch,
  History,
  LoaderCircle,
  Search,
  Sparkles,
  Table2,
  Trash2,
} from "lucide-react";
import type {
  ComparisonReport,
  Paper,
  ProviderProfile,
} from "../../shared/contracts";

interface ComparisonWorkspaceProps {
  papers: Paper[];
  provider?: ProviderProfile;
  onOpenCitation: (paperId: string, page: number) => void;
  onError: (message: string) => void;
}

const DEFAULT_QUESTION =
  "比较这些论文的理论方法、Hamiltonian、关键近似、计算设置、主要结果与局限性。";

const presets = [
  {
    label: "方法与近似",
    value:
      "比较这些论文采用的 Hamiltonian、理论方法、关键近似、basis set/functional 与 electron correlation 处理。",
  },
  {
    label: "复现参数",
    value:
      "比较这些论文的计算体系、软件、收敛标准、相对论处理、赝势及其他可复现参数。",
  },
  {
    label: "结果与局限",
    value:
      "比较这些论文的主要 observable、基准结果、误差来源、适用范围与作者明确陈述的局限性。",
  },
];

type ComparisonView = "matrix" | "report";
type MatrixFieldKey =
  | "theory"
  | "hamiltonian"
  | "approximation"
  | "basis"
  | "correlation"
  | "settings"
  | "result";

interface MatrixField {
  key: MatrixFieldKey;
  label: string;
  shortLabel: string;
}

type MatrixValues = Record<MatrixFieldKey, string>;
type MatrixRows = Record<string, MatrixValues>;

const MATRIX_FIELDS: MatrixField[] = [
  { key: "theory", label: "理论方法", shortLabel: "Theory / method" },
  { key: "hamiltonian", label: "Hamiltonian", shortLabel: "Hamiltonian" },
  { key: "approximation", label: "关键近似", shortLabel: "Approximations" },
  { key: "basis", label: "基组 / 泛函", shortLabel: "Basis / functional" },
  { key: "correlation", label: "电子相关", shortLabel: "Correlation" },
  { key: "settings", label: "计算设置", shortLabel: "Settings" },
  { key: "result", label: "主要结果", shortLabel: "Key result" },
];

const MATRIX_STORAGE_PREFIX = "paperxcel.comparison-matrix:";
const MATRIX_VIEW_STORAGE_KEY = "paperxcel.comparison-view";

export function ComparisonWorkspace({
  papers,
  provider,
  onOpenCitation,
  onError,
}: ComparisonWorkspaceProps): React.JSX.Element {
  const readyPapers = useMemo(
    () =>
      papers
        .filter((paper) => paper.status === "ready")
        .sort((a, b) => a.title.localeCompare(b.title)),
    [papers],
  );
  const paperById = useMemo(
    () => new Map(papers.map((paper) => [paper.id, paper])),
    [papers],
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [question, setQuestion] = useState(DEFAULT_QUESTION);
  const [reports, setReports] = useState<ComparisonReport[]>([]);
  const [selectedReportId, setSelectedReportId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [activeView, setActiveView] = useState<ComparisonView>(() => {
    try {
      return window.localStorage.getItem(MATRIX_VIEW_STORAGE_KEY) === "report"
        ? "report"
        : "matrix";
    } catch {
      return "matrix";
    }
  });
  const [matrixQuery, setMatrixQuery] = useState("");
  const [matrixField, setMatrixField] = useState<"all" | MatrixFieldKey>("all");
  const [onlyFilled, setOnlyFilled] = useState(false);
  const [matrixRows, setMatrixRows] = useState<MatrixRows>({});
  const [matrixReadyKey, setMatrixReadyKey] = useState("");

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    void window.paperxcel.comparisons
      .list()
      .then((items) => {
        if (disposed) return;
        setReports(items);
        setSelectedReportId((current) =>
          current && items.some((report) => report.id === current)
            ? current
            : items[0]?.id,
        );
      })
      .catch((error: unknown) => {
        if (!disposed) onError(errorMessage(error));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [onError]);

  useEffect(() => {
    setSelectedIds((current) => {
      const readyIds = new Set(readyPapers.map((paper) => paper.id));
      const next = new Set(
        [...current].filter((paperId) => readyIds.has(paperId)),
      );
      for (const paper of readyPapers) {
        if (next.size >= 2) break;
        next.add(paper.id);
      }
      return next;
    });
  }, [readyPapers]);

  const selectedPapers = readyPapers.filter((paper) =>
    selectedIds.has(paper.id),
  );
  const selectedReport =
    reports.find((report) => report.id === selectedReportId) ?? reports[0];
  const matrixPapers = useMemo(() => {
    const paperIds =
      selectedReport?.paperIds ?? selectedPapers.map((paper) => paper.id);
    return paperIds
      .map((paperId) => paperById.get(paperId))
      .filter((paper): paper is Paper => Boolean(paper));
  }, [paperById, selectedPapers, selectedReport]);
  const matrixStorageKey = useMemo(() => {
    if (selectedReport) return `${MATRIX_STORAGE_PREFIX}${selectedReport.id}`;
    const draftId =
      selectedPapers.map((paper) => paper.id).join("|") || "empty";
    return `${MATRIX_STORAGE_PREFIX}draft:${draftId}`;
  }, [selectedPapers, selectedReport]);
  const visibleMatrixFields =
    matrixField === "all"
      ? MATRIX_FIELDS
      : MATRIX_FIELDS.filter((field) => field.key === matrixField);
  const visibleMatrixPapers = matrixPapers.filter((paper) => {
    const values = matrixRows[paper.id];
    const haystack = [
      paper.title,
      ...paper.authors,
      ...MATRIX_FIELDS.map((field) => values?.[field.key] ?? ""),
    ]
      .join(" ")
      .toLocaleLowerCase();
    const matchesQuery =
      !matrixQuery.trim() ||
      haystack.includes(matrixQuery.trim().toLocaleLowerCase());
    const hasFilledValue = MATRIX_FIELDS.some((field) =>
      values?.[field.key]?.trim(),
    );
    return matchesQuery && (!onlyFilled || hasFilledValue);
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(MATRIX_VIEW_STORAGE_KEY, activeView);
    } catch {
      // Local persistence is optional in restricted browser contexts.
    }
  }, [activeView]);

  useEffect(() => {
    let nextRows: MatrixRows = {};
    try {
      const saved = window.localStorage.getItem(matrixStorageKey);
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<MatrixRows>;
        nextRows = Object.fromEntries(
          Object.entries(parsed).map(([paperId, values]) => [
            paperId,
            normalizeMatrixValues(values),
          ]),
        );
      }
    } catch {
      nextRows = {};
    }
    for (const paper of matrixPapers) {
      nextRows[paper.id] = normalizeMatrixValues(nextRows[paper.id]);
    }
    setMatrixRows(nextRows);
    setMatrixReadyKey(matrixStorageKey);
  }, [matrixPapers, matrixStorageKey]);

  useEffect(() => {
    if (matrixReadyKey !== matrixStorageKey) return;
    try {
      window.localStorage.setItem(matrixStorageKey, JSON.stringify(matrixRows));
    } catch {
      // Local persistence is optional in restricted browser contexts.
    }
  }, [matrixReadyKey, matrixRows, matrixStorageKey]);

  const togglePaper = (paperId: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(paperId)) next.delete(paperId);
      else if (next.size < 5) next.add(paperId);
      return next;
    });
  };

  const generate = async (): Promise<void> => {
    if (
      generating ||
      selectedPapers.length < 2 ||
      selectedPapers.length > 5 ||
      !question.trim()
    ) {
      return;
    }
    setGenerating(true);
    try {
      const report = await window.paperxcel.comparisons.generate({
        paperIds: selectedPapers.map((paper) => paper.id),
        question: question.trim(),
      });
      setReports((current) => [
        report,
        ...current.filter((item) => item.id !== report.id),
      ]);
      setSelectedReportId(report.id);
      setActiveView("report");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setGenerating(false);
    }
  };

  const removeReport = async (): Promise<void> => {
    if (!selectedReport || generating) return;
    if (!window.confirm("删除这份本地跨文献比较报告？")) return;
    try {
      await window.paperxcel.comparisons.remove(selectedReport.id);
      const next = reports.filter((report) => report.id !== selectedReport.id);
      setReports(next);
      setSelectedReportId(next[0]?.id);
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  const exportReport = async (): Promise<void> => {
    if (!selectedReport || exporting) return;
    setExporting(true);
    try {
      await window.paperxcel.comparisons.exportMarkdown(selectedReport.id);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setExporting(false);
    }
  };

  const updateMatrixCell = (
    paperId: string,
    field: MatrixFieldKey,
    value: string,
  ): void => {
    setMatrixRows((current) => ({
      ...current,
      [paperId]: {
        ...normalizeMatrixValues(current[paperId]),
        [field]: value,
      },
    }));
  };

  const clearMatrix = (): void => {
    if (!matrixPapers.length) return;
    if (!window.confirm("清空当前研究矩阵中的手工内容？")) return;
    setMatrixRows(
      Object.fromEntries(
        matrixPapers.map((paper) => [paper.id, normalizeMatrixValues()]),
      ),
    );
  };

  return (
    <section className="comparison-workspace">
      <header className="comparison-header">
        <div className="comparison-heading">
          <span className="comparison-heading-icon">
            <Columns3 size={18} />
          </span>
          <div>
            <h2>研究矩阵</h2>
            <p>
              {provider
                ? `${provider.name} · ${provider.model}`
                : "尚未配置模型"}
            </p>
          </div>
        </div>
        <div className="comparison-header-actions">
          <div
            className="comparison-view-tabs"
            role="tablist"
            aria-label="结果视图"
          >
            <button
              className={activeView === "matrix" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={activeView === "matrix"}
              onClick={() => setActiveView("matrix")}
            >
              <Table2 size={14} />
              矩阵
            </button>
            <button
              className={activeView === "report" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={activeView === "report"}
              onClick={() => setActiveView("report")}
            >
              <FileSearch size={14} />
              报告
            </button>
          </div>
          {selectedReport && (
            <>
              <button
                className="icon-button"
                type="button"
                title="导出 Markdown"
                disabled={exporting}
                onClick={() => void exportReport()}
              >
                {exporting ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Download size={16} />
                )}
              </button>
              <button
                className="icon-button danger"
                type="button"
                title="删除比较报告"
                onClick={() => void removeReport()}
              >
                <Trash2 size={16} />
              </button>
            </>
          )}
        </div>
      </header>

      <div className="comparison-layout">
        <aside className="comparison-controls">
          <section className="comparison-control-section">
            <div className="comparison-section-heading">
              <strong>文献</strong>
              <span>{selectedPapers.length}/5</span>
            </div>
            <div className="comparison-paper-list">
              {readyPapers.length === 0 && (
                <div className="comparison-small-empty">
                  <FileSearch size={20} />
                  <span>暂无已索引文献</span>
                </div>
              )}
              {readyPapers.map((paper) => {
                const selectedIndex = selectedPapers.findIndex(
                  (item) => item.id === paper.id,
                );
                const checked = selectedIndex >= 0;
                return (
                  <label
                    className={`comparison-paper-row ${checked ? "selected" : ""}`}
                    key={paper.id}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && selectedIds.size >= 5}
                      onChange={() => togglePaper(paper.id)}
                    />
                    <span className="comparison-paper-label">
                      {checked ? `P${selectedIndex + 1}` : ""}
                    </span>
                    <span className="comparison-paper-copy">
                      <strong>{paper.title}</strong>
                      <small>
                        {paper.authors.slice(0, 2).join(", ") || "作者待补全"}
                        {paper.pageCount ? ` · ${paper.pageCount} 页` : ""}
                      </small>
                    </span>
                  </label>
                );
              })}
            </div>
          </section>

          <section className="comparison-control-section comparison-question">
            <div className="comparison-section-heading">
              <strong>研究问题</strong>
              <span>{question.length}/2000</span>
            </div>
            <div className="comparison-presets">
              {presets.map((preset) => (
                <button
                  type="button"
                  key={preset.label}
                  onClick={() => setQuestion(preset.value)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <textarea
              aria-label="跨文献研究问题"
              maxLength={2000}
              rows={6}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
            />
            <button
              className="comparison-generate-button"
              type="button"
              disabled={
                generating ||
                selectedPapers.length < 2 ||
                !question.trim() ||
                !provider?.hasApiKey
              }
              onClick={() => void generate()}
            >
              {generating ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Sparkles size={16} />
              )}
              {generating ? "正在比较" : "生成研究矩阵"}
            </button>
          </section>

          <section className="comparison-control-section comparison-history">
            <div className="comparison-section-heading">
              <strong>历史报告</strong>
              <History size={14} />
            </div>
            <div className="comparison-history-list">
              {!reports.length && (
                <div className="comparison-history-empty">暂无报告</div>
              )}
              {reports.map((report) => (
                <button
                  className={`comparison-history-row ${
                    selectedReport?.id === report.id ? "selected" : ""
                  }`}
                  type="button"
                  key={report.id}
                  onClick={() => setSelectedReportId(report.id)}
                >
                  <span className="comparison-history-date">
                    {formatDate(report.createdAt)}
                  </span>
                  <strong>{report.question}</strong>
                  <small>
                    {report.paperIds.length} 篇 · {report.citations.length}{" "}
                    条引用
                  </small>
                </button>
              ))}
            </div>
          </section>
        </aside>

        <div className="comparison-report-pane">
          {loading ? (
            <div className="comparison-report-empty">
              <LoaderCircle className="spin" size={24} />
              <strong>正在加载报告</strong>
            </div>
          ) : activeView === "matrix" ? (
            <MatrixView
              papers={visibleMatrixPapers}
              fields={visibleMatrixFields}
              rows={matrixRows}
              totalPapers={matrixPapers.length}
              query={matrixQuery}
              field={matrixField}
              onlyFilled={onlyFilled}
              hasReport={Boolean(selectedReport)}
              onQueryChange={setMatrixQuery}
              onFieldChange={setMatrixField}
              onOnlyFilledChange={setOnlyFilled}
              onClear={clearMatrix}
              onCellChange={updateMatrixCell}
              onOpenCitation={onOpenCitation}
            />
          ) : selectedReport ? (
            <article className="comparison-report">
              <header className="comparison-report-header">
                <div>
                  <span>研究问题</span>
                  <h3>{selectedReport.question}</h3>
                </div>
                <small>
                  {selectedReport.model} ·{" "}
                  {formatDate(selectedReport.createdAt)}
                </small>
              </header>
              <div className="comparison-report-content">
                {selectedReport.content}
              </div>
              <section className="comparison-sources">
                <div className="comparison-sources-heading">
                  <strong>证据索引</strong>
                  <span>{selectedReport.citations.length} 条</span>
                </div>
                {selectedReport.citations.map((citation) => {
                  const paper = paperById.get(citation.paperId);
                  return (
                    <button
                      className="comparison-source-row"
                      type="button"
                      key={`${citation.paperLabel}-${citation.page}`}
                      title={`打开 ${citation.paperLabel} 第 ${citation.page} 页`}
                      onClick={() =>
                        onOpenCitation(citation.paperId, citation.page)
                      }
                    >
                      <span className="comparison-source-key">
                        {citation.paperLabel}
                        <small>p.{citation.page}</small>
                      </span>
                      <span className="comparison-source-copy">
                        <strong>{paper?.title ?? "已移除文献"}</strong>
                        <small>{citation.excerpt ?? "未提取到证据摘录"}</small>
                      </span>
                      <ArrowUpRight size={15} />
                    </button>
                  );
                })}
              </section>
            </article>
          ) : (
            <div className="comparison-report-empty">
              <Columns3 size={28} />
              <strong>尚无比较报告</strong>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

interface MatrixViewProps {
  papers: Paper[];
  fields: MatrixField[];
  rows: MatrixRows;
  totalPapers: number;
  query: string;
  field: "all" | MatrixFieldKey;
  onlyFilled: boolean;
  hasReport: boolean;
  onQueryChange: (value: string) => void;
  onFieldChange: (value: "all" | MatrixFieldKey) => void;
  onOnlyFilledChange: (value: boolean) => void;
  onClear: () => void;
  onCellChange: (paperId: string, field: MatrixFieldKey, value: string) => void;
  onOpenCitation: (paperId: string, page: number) => void;
}

function MatrixView({
  papers,
  fields,
  rows,
  totalPapers,
  query,
  field,
  onlyFilled,
  hasReport,
  onQueryChange,
  onFieldChange,
  onOnlyFilledChange,
  onClear,
  onCellChange,
  onOpenCitation,
}: MatrixViewProps): React.JSX.Element {
  return (
    <div className="comparison-matrix-view">
      <div className="comparison-matrix-toolbar">
        <div className="comparison-matrix-toolbar-heading">
          <div>
            <strong>研究矩阵</strong>
            <span>
              {totalPapers} 篇文献 · {MATRIX_FIELDS.length} 个字段
            </span>
          </div>
          <span className="comparison-matrix-saved" title="已保存到本地">
            <Check size={13} />
            已保存
          </span>
        </div>
        <div className="comparison-matrix-tools">
          <label className="comparison-matrix-search">
            <Search size={14} />
            <input
              aria-label="筛选矩阵"
              placeholder="筛选文献或字段"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
            />
          </label>
          <select
            aria-label="字段筛选"
            value={field}
            onChange={(event) =>
              onFieldChange(event.target.value as "all" | MatrixFieldKey)
            }
          >
            <option value="all">全部字段</option>
            {MATRIX_FIELDS.map((item) => (
              <option value={item.key} key={item.key}>
                {item.label}
              </option>
            ))}
          </select>
          <label className="comparison-matrix-check">
            <input
              type="checkbox"
              checked={onlyFilled}
              onChange={(event) => onOnlyFilledChange(event.target.checked)}
            />
            已填写
          </label>
          <button
            className="icon-button"
            type="button"
            title="清空手工矩阵"
            disabled={!papers.length}
            onClick={onClear}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {!hasReport && (
        <div className="comparison-matrix-notice">
          <Sparkles size={15} />
          先生成一份比较报告，再把证据整理进下方字段。
        </div>
      )}

      {papers.length === 0 ? (
        <div className="comparison-report-empty">
          <Table2 size={28} />
          <strong>
            {totalPapers ? "没有匹配的文献" : "先选择至少两篇文献"}
          </strong>
          <span>调整筛选条件或返回左侧选择文献。</span>
        </div>
      ) : (
        <div className="comparison-matrix-scroll">
          <table className="comparison-matrix-table">
            <thead>
              <tr>
                <th className="comparison-matrix-paper-column">文献</th>
                {fields.map((item) => (
                  <th key={item.key}>
                    <span>{item.label}</span>
                    <small>{item.shortLabel}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {papers.map((paper, index) => {
                const values = normalizeMatrixValues(rows[paper.id]);
                return (
                  <tr key={paper.id}>
                    <th className="comparison-matrix-paper">
                      <button
                        type="button"
                        title={`打开 ${paper.title} 的第一页`}
                        onClick={() => onOpenCitation(paper.id, 1)}
                      >
                        <span className="comparison-paper-label">
                          P{index + 1}
                        </span>
                        <span>
                          <strong>{paper.title}</strong>
                          <small>
                            {paper.authors.slice(0, 2).join(", ") ||
                              "作者待补全"}
                            {paper.pageCount ? ` · ${paper.pageCount} 页` : ""}
                          </small>
                        </span>
                        <ArrowUpRight size={14} />
                      </button>
                    </th>
                    {fields.map((item) => (
                      <td key={item.key}>
                        <textarea
                          aria-label={`${paper.title} · ${item.label}`}
                          placeholder="待确认"
                          value={values[item.key]}
                          onChange={(event) =>
                            onCellChange(paper.id, item.key, event.target.value)
                          }
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeMatrixValues(values?: Partial<MatrixValues>): MatrixValues {
  return Object.fromEntries(
    MATRIX_FIELDS.map((field) => [field.key, values?.[field.key] ?? ""]),
  ) as MatrixValues;
}
