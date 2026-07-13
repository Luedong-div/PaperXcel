import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dagre from "@dagrejs/dagre";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowDownLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleHelp,
  Copy,
  Database,
  ExternalLink,
  FilePlus2,
  FileText,
  Filter,
  FolderOpen,
  Link2,
  LoaderCircle,
  Maximize2,
  Minus,
  Network,
  RefreshCw,
  Search,
  Settings2,
  X,
} from "lucide-react";
import type {
  CitationGraphNode,
  CitationGraphSnapshot,
  LibraryFolder,
  Paper,
} from "../../shared/contracts";
import { normalizeCitationDoi } from "../../shared/citationGraph";

interface CitationGraphWorkspaceProps {
  papers: Paper[];
  folders: LibraryFolder[];
  onOpenPaper: (paperId: string) => void;
  onPaperImported: (paper: Paper) => void;
  onOpenSettings: () => void;
  onError: (message: string) => void;
}

interface CitationNodeData extends Record<string, unknown> {
  citation: CitationGraphNode;
  dimmed: boolean;
}

type CitationFlowNode = Node<CitationNodeData, "citation">;
type DetailTab = "details" | "abstract" | "notes" | "relations";

interface DetailPanelPosition {
  left: number;
  top: number;
}

const nodeTypes = { citation: CitationNode };
const nodeWidth = 184;
const nodeHeight = 42;
const detailPanelWidth = 380;
const detailPanelMinHeight = 320;

function clampDetailPanelPosition(
  position: DetailPanelPosition,
): DetailPanelPosition {
  const renderedWidth = Math.min(detailPanelWidth, window.innerWidth - 24);
  const maxLeft = Math.max(12, window.innerWidth - renderedWidth - 12);
  const maxTop = Math.max(44, window.innerHeight - detailPanelMinHeight - 16);
  return {
    left: Math.max(12, Math.min(position.left, maxLeft)),
    top: Math.max(44, Math.min(position.top, maxTop)),
  };
}

export function CitationGraphWorkspace(
  props: CitationGraphWorkspaceProps,
): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <CitationGraphWorkspaceContent {...props} />
    </ReactFlowProvider>
  );
}

function CitationGraphWorkspaceContent({
  papers,
  folders,
  onOpenPaper,
  onPaperImported,
  onOpenSettings,
  onError,
}: CitationGraphWorkspaceProps): React.JSX.Element {
  const { fitView } = useReactFlow();
  const [snapshot, setSnapshot] = useState<CitationGraphSnapshot>({
    nodes: [],
    edges: [],
    errors: [],
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState("");
  const [localPickerOpen, setLocalPickerOpen] = useState(true);
  const [selectedPaperIds, setSelectedPaperIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [showLocal, setShowLocal] = useState(true);
  const [showExternal, setShowExternal] = useState(true);
  const [showReferences, setShowReferences] = useState(true);
  const [showCiting, setShowCiting] = useState(true);
  const [selectedYearRange, setSelectedYearRange] =
    useState<[number, number]>();
  const [timelineOpen, setTimelineOpen] = useState(true);
  const [selectedId, setSelectedId] = useState<string>();
  const [detailMinimized, setDetailMinimized] = useState(false);
  const [detailPosition, setDetailPosition] = useState<DetailPanelPosition>(
    () =>
      clampDetailPanelPosition({
        left: window.innerWidth - detailPanelWidth - 18,
        top: 122,
      }),
  );
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>("details");
  const [noteContent, setNoteContent] = useState("");
  const [noteLoading, setNoteLoading] = useState(false);
  const detailDragRef = useRef<
    | {
        pointerId: number;
        offsetX: number;
        offsetY: number;
      }
    | undefined
  >(undefined);

  const selectedPaperIdList = useMemo(
    () =>
      papers
        .filter((paper) => selectedPaperIds.has(paper.id))
        .map((paper) => paper.id),
    [papers, selectedPaperIds],
  );
  const selectionScopeKey = selectedPaperIdList.join("\u0000");
  const selectionScopeRef = useRef(selectionScopeKey);

  useEffect(() => {
    selectionScopeRef.current = selectionScopeKey;
  }, [selectionScopeKey]);

  useEffect(() => {
    setSelectedPaperIds((current) => {
      const availableIds = new Set(papers.map((paper) => paper.id));
      const next = new Set(
        [...current].filter((paperId) => availableIds.has(paperId)),
      );
      return next.size === current.size ? current : next;
    });
  }, [papers]);

  const loadSnapshot = useCallback(async (): Promise<void> => {
    const requestedScope = selectionScopeKey;
    setLoading(true);
    try {
      const nextSnapshot =
        await window.paperxcel.citationGraph.get(selectedPaperIdList);
      if (selectionScopeRef.current === requestedScope) {
        setSnapshot(nextSnapshot);
      }
    } catch (error) {
      if (selectionScopeRef.current === requestedScope) {
        onError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (selectionScopeRef.current === requestedScope) {
        setLoading(false);
      }
    }
  }, [onError, selectedPaperIdList, selectionScopeKey]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  const refresh = async (force = false): Promise<void> => {
    if (refreshing) return;
    const requestedScope = selectionScopeKey;
    setRefreshing(true);
    try {
      const result = await window.paperxcel.citationGraph.refresh(
        force,
        selectedPaperIdList,
      );
      if (selectionScopeRef.current !== requestedScope) return;
      setSnapshot(result.snapshot);
      if (result.failedPapers > 0) {
        onError(`图谱已更新，但有 ${result.failedPapers} 篇论文同步失败。`);
      }
    } catch (error) {
      if (selectionScopeRef.current === requestedScope) {
        onError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setRefreshing(false);
    }
  };

  const updateSelectedPaperIds = (next: Set<string>): void => {
    selectionScopeRef.current = papers
      .filter((paper) => next.has(paper.id))
      .map((paper) => paper.id)
      .join("\u0000");
    setSelectedPaperIds(next);
    setSnapshot({ nodes: [], edges: [], errors: [] });
    setLoading(true);
    setSelectedId(undefined);
    setDetailMinimized(false);
  };

  const togglePaper = (paperId: string): void => {
    const next = new Set(selectedPaperIds);
    if (next.has(paperId)) next.delete(paperId);
    else next.add(paperId);
    updateSelectedPaperIds(next);
  };

  const selectAllPapers = (): void =>
    updateSelectedPaperIds(new Set(papers.map((paper) => paper.id)));

  const clearSelectedPapers = (): void => updateSelectedPaperIds(new Set());

  const toggleFolder = (folderPaperIds: string[]): void => {
    const next = new Set(selectedPaperIds);
    const shouldSelect = folderPaperIds.some((paperId) => !next.has(paperId));
    for (const paperId of folderPaperIds) {
      if (shouldSelect) next.add(paperId);
      else next.delete(paperId);
    }
    updateSelectedPaperIds(next);
  };

  const selectedScopeLabel =
    selectedPaperIdList.length > 0
      ? `已选 ${selectedPaperIdList.length} 篇本地论文`
      : "尚未选择本地论文";

  const scopedSnapshot = useMemo(
    () =>
      markLibraryNodes(
        scopeCitationSnapshot(snapshot, selectedPaperIds),
        papers,
      ),
    [papers, selectedPaperIds, snapshot],
  );

  useEffect(() => {
    if (
      selectedId &&
      !scopedSnapshot.nodes.some((node) => node.id === selectedId)
    ) {
      setSelectedId(undefined);
      setDetailMinimized(false);
    }
  }, [scopedSnapshot.nodes, selectedId]);

  const selected = scopedSnapshot.nodes.find((node) => node.id === selectedId);
  const selectedPaper = useMemo(() => {
    if (!selected) return undefined;
    if (selected.paperId) {
      return papers.find((paper) => paper.id === selected.paperId);
    }
    if (selected.doi) {
      return papers.find(
        (paper) =>
          normalizeCitationDoi(paper.doi) ===
          normalizeCitationDoi(selected.doi),
      );
    }
    return undefined;
  }, [papers, selected]);

  useEffect(() => {
    setActiveTab("details");
    setNoteContent("");
  }, [selectedId]);

  useEffect(() => {
    const keepPanelInViewport = (): void => {
      setDetailPosition((current) => clampDetailPanelPosition(current));
    };
    window.addEventListener("resize", keepPanelInViewport);
    return () => window.removeEventListener("resize", keepPanelInViewport);
  }, []);

  useEffect(() => {
    if (activeTab !== "notes" || !selectedPaper) return;
    let cancelled = false;
    setNoteLoading(true);
    void window.paperxcel.notes
      .get(selectedPaper.id)
      .then((note) => {
        if (!cancelled) setNoteContent(note?.content ?? "");
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          onError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setNoteLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, onError, selectedPaper]);

  const timeline = useMemo(() => {
    const years = Array.from(
      new Set(
        scopedSnapshot.nodes
          .map((node) => node.year)
          .filter((year): year is number => typeof year === "number"),
      ),
    ).sort((first, second) => first - second);
    return years.map((year) => {
      return {
        year,
        count: scopedSnapshot.nodes.filter((node) => node.year === year).length,
      };
    });
  }, [scopedSnapshot.nodes]);
  const firstTimelineYear = timeline[0]?.year;
  const lastTimelineYear = timeline[timeline.length - 1]?.year;
  const rangeStartYear = selectedYearRange?.[0] ?? firstTimelineYear;
  const rangeEndYear = selectedYearRange?.[1] ?? lastTimelineYear;
  const selectedYearLabel = selectedYearRange
    ? selectedYearRange[0] === selectedYearRange[1]
      ? String(selectedYearRange[0])
      : `${selectedYearRange[0]} - ${selectedYearRange[1]}`
    : undefined;

  const updateRangeStart = (year: number): void => {
    const end = selectedYearRange?.[1] ?? lastTimelineYear ?? year;
    setSelectedYearRange([year, Math.max(year, end)]);
  };

  const updateRangeEnd = (year: number): void => {
    const start = selectedYearRange?.[0] ?? firstTimelineYear ?? year;
    setSelectedYearRange([Math.min(start, year), year]);
  };

  const visibleSnapshot = useMemo(() => {
    const visibleIds = new Set(
      scopedSnapshot.nodes
        .filter((node) => {
          if (
            selectedYearRange &&
            (typeof node.year !== "number" ||
              node.year < selectedYearRange[0] ||
              node.year > selectedYearRange[1])
          ) {
            return false;
          }
          if (node.kind === "library") return showLocal;
          if (!showExternal) return false;
          return (
            (showReferences && node.referencedByLibrary) ||
            (showCiting && node.citesLibrary)
          );
        })
        .map((node) => node.id),
    );
    return {
      nodes: scopedSnapshot.nodes.filter((node) => visibleIds.has(node.id)),
      edges: scopedSnapshot.edges.filter(
        (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
      ),
    };
  }, [
    selectedYearRange,
    showCiting,
    showExternal,
    showLocal,
    showReferences,
    scopedSnapshot.edges,
    scopedSnapshot.nodes,
  ]);

  const flow = useMemo(
    () => buildFlowGraph(visibleSnapshot.nodes, visibleSnapshot.edges, query),
    [query, visibleSnapshot.edges, visibleSnapshot.nodes],
  );

  useEffect(() => {
    if (!flow.nodes.length) return;
    let secondFrame: number | undefined;
    const fit = (): void => {
      void fitView({ padding: 0.16, duration: 0 });
    };
    const frame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(fit);
    });
    const retry = window.setTimeout(fit, 180);
    return () => {
      window.cancelAnimationFrame(frame);
      if (secondFrame !== undefined) {
        window.cancelAnimationFrame(secondFrame);
      }
      window.clearTimeout(retry);
    };
  }, [fitView, flow.layoutKey, flow.nodes.length]);

  useEffect(() => {
    let timeout: number | undefined;
    const handleResize = (): void => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        void fitView({ padding: 0.16, duration: 0 });
      }, 100);
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("resize", handleResize);
    };
  }, [fitView]);

  const importSelected = async (): Promise<void> => {
    if (!selected?.doi || importing) return;
    setImporting(true);
    try {
      const paper = await window.paperxcel.papers.addFromIdentifier(
        selected.doi,
      );
      onPaperImported(paper);
      await loadSnapshot();
      setSelectedId(`paper:${paper.id}`);
      setDetailMinimized(false);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  };

  const copyDoi = async (): Promise<void> => {
    if (!selected?.doi) return;
    await window.paperxcel.clipboard.writeText(selected.doi);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  const openSelectedSource = (): void => {
    if (!selected) return;
    if (selectedPaper?.sourceUrl) {
      void window.paperxcel.papers.openSource(selectedPaper.id);
      return;
    }
    const sourceUrl =
      selected.sourceUrl ??
      (selected.doi ? `https://doi.org/${selected.doi}` : undefined);
    if (sourceUrl) window.open(sourceUrl, "_blank");
  };

  const openDetails = (nodeId: string): void => {
    setSelectedId(nodeId);
    setDetailMinimized(false);
  };

  const closeDetails = (): void => {
    setSelectedId(undefined);
    setDetailMinimized(false);
  };

  const startDetailDrag = (
    event: React.PointerEvent<HTMLElement>,
  ): void => {
    if (event.button !== 0) return;
    const rect = event.currentTarget
      .closest(".citation-detail-popover")
      ?.getBoundingClientRect();
    if (!rect) return;
    detailDragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDetailPanel = (
    event: React.PointerEvent<HTMLElement>,
  ): void => {
    const drag = detailDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setDetailPosition(
      clampDetailPanelPosition({
        left: event.clientX - drag.offsetX,
        top: event.clientY - drag.offsetY,
      }),
    );
  };

  const stopDetailDrag = (
    event: React.PointerEvent<HTMLElement>,
  ): void => {
    if (detailDragRef.current?.pointerId !== event.pointerId) return;
    detailDragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const libraryCount = scopedSnapshot.nodes.filter(
    (node) => node.kind === "library",
  ).length;
  const externalCount = scopedSnapshot.nodes.length - libraryCount;
  const referenceCount = scopedSnapshot.nodes.filter(
    (node) => node.referencedByLibrary,
  ).length;
  const citingCount = scopedSnapshot.nodes.filter(
    (node) => node.citesLibrary,
  ).length;
  const relatedNodes = selected
    ? getRelatedNodes(selected, scopedSnapshot)
    : [];
  const paperGroups = buildPaperGroups(papers, folders);

  return (
    <section className="citation-browser">
      <header className="citation-browser-bar citation-graph-toolbar">
        <div className="citation-browser-heading">
          <span className="citation-browser-heading-icon">
            <Network size={18} />
          </span>
          <div>
            <h2>引文图谱</h2>
            <p title={selectedScopeLabel}>
              {selectedScopeLabel} · OpenAlex 引用关系网络
            </p>
          </div>
        </div>
        <label className="citation-browser-search">
          <Search size={15} />
          <input
            value={query}
            placeholder="搜索标题、作者、DOI 等"
            aria-label="搜索引文图谱"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              title="清除搜索"
              onClick={() => setQuery("")}
            >
              <X size={14} />
            </button>
          )}
        </label>
        <div className="citation-browser-header-actions">
          <button
            className="citation-browser-icon-control"
            type="button"
            title="OpenAlex 设置"
            onClick={onOpenSettings}
          >
            <Settings2 size={17} />
          </button>
          <button
            className="citation-browser-refresh"
            type="button"
            disabled={refreshing || selectedPaperIdList.length === 0}
            onClick={() => void refresh(false)}
          >
            {refreshing ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <RefreshCw size={15} />
            )}
            刷新
          </button>
        </div>
      </header>

      {snapshot.errors.length > 0 && (
        <div className="citation-browser-error">
          <CircleErrorText errors={snapshot.errors} />
          <button type="button" onClick={() => void refresh(true)}>
            重试全部
          </button>
        </div>
      )}

      <div className="citation-browser-layout">
        <aside className="citation-browser-filters">
          <div className="citation-filter-heading">
            <span>当前文献</span>
            <span title="以当前资料库中已获取关系的论文为中心构建图谱">
              <CircleHelp size={14} />
            </span>
          </div>
          <h2 title={selectedScopeLabel}>{selectedScopeLabel}</h2>
          <section className="citation-local-picker-section">
            <button
              className="citation-local-picker-heading"
              type="button"
              onClick={() => setLocalPickerOpen((open) => !open)}
              aria-expanded={localPickerOpen}
            >
              <span>
                <FolderOpen size={15} />
                本地文献
              </span>
              <span className="citation-local-picker-count">
                {selectedPaperIdList.length}/{papers.length}
                {localPickerOpen ? (
                  <ChevronUp size={14} />
                ) : (
                  <ChevronDown size={14} />
                )}
              </span>
            </button>
            {localPickerOpen && (
              <div className="citation-local-picker">
                <div className="citation-local-picker-actions">
                  <span>选择构建范围</span>
                  <button type="button" onClick={selectAllPapers}>
                    全选
                  </button>
                  <button type="button" onClick={clearSelectedPapers}>
                    清空
                  </button>
                </div>
                <div className="citation-local-picker-tree">
                  {paperGroups.map((group) => (
                    <PaperSelectionGroup
                      key={group.id}
                      group={group}
                      selectedPaperIds={selectedPaperIds}
                      onTogglePaper={togglePaper}
                      onToggleGroup={toggleFolder}
                    />
                  ))}
                  {papers.length === 0 && (
                    <span className="citation-local-picker-empty">
                      本地资料库暂无论文
                    </span>
                  )}
                </div>
              </div>
            )}
          </section>
          <p>引文网络视图</p>

          <section className="citation-filter-section">
            <span className="citation-filter-label">数据源</span>
            <label className="citation-filter-toggle">
              <input
                type="checkbox"
                checked={showLocal}
                onChange={(event) => setShowLocal(event.target.checked)}
              />
              <span className="citation-toggle-mark local" />
              本地节点
              <small>{libraryCount}</small>
            </label>
            <label className="citation-filter-toggle">
              <input
                type="checkbox"
                checked={showExternal}
                onChange={(event) => setShowExternal(event.target.checked)}
              />
              <span className="citation-toggle-mark external" />
              外部节点
              <small>{externalCount}</small>
            </label>
          </section>

          <section className="citation-filter-section">
            <span className="citation-filter-label">关系类型</span>
            <label className="citation-filter-toggle">
              <input
                type="checkbox"
                checked={showReferences}
                onChange={(event) => setShowReferences(event.target.checked)}
              />
              <ArrowDownLeft size={14} />
              参考文献
              <small className="citation-reference-count">
                {referenceCount}
              </small>
            </label>
            <label className="citation-filter-toggle">
              <input
                type="checkbox"
                checked={showCiting}
                onChange={(event) => setShowCiting(event.target.checked)}
              />
              <ArrowUpRight size={14} />
              引用本文
              <small className="citation-citing-count">{citingCount}</small>
            </label>
          </section>

          <section className="citation-filter-section citation-timeline">
            <button
              className="citation-timeline-heading"
              type="button"
              onClick={() => setTimelineOpen((open) => !open)}
              aria-expanded={timelineOpen}
            >
              <span>
                <Filter size={14} />
                时间范围
              </span>
              {timelineOpen ? (
                <ChevronUp size={15} />
              ) : (
                <ChevronDown size={15} />
              )}
            </button>
            {timelineOpen && (
              <>
                <button
                  className={`citation-year-all ${
                    selectedYearRange ? "" : "active"
                  }`}
                  type="button"
                  onClick={() => setSelectedYearRange(undefined)}
                >
                  所有年份
                </button>
                <div
                  className="citation-year-range-controls"
                  aria-label="年份范围"
                >
                  <label>
                    <span>起始</span>
                    <select
                      aria-label="起始年份"
                      disabled={timeline.length === 0}
                      value={rangeStartYear ?? ""}
                      onChange={(event) =>
                        updateRangeStart(Number(event.target.value))
                      }
                    >
                      {timeline.map(({ year }) => (
                        <option key={year} value={year}>
                          {year}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span>至</span>
                  <label>
                    <span>结束</span>
                    <select
                      aria-label="结束年份"
                      disabled={timeline.length === 0}
                      value={rangeEndYear ?? ""}
                      onChange={(event) =>
                        updateRangeEnd(Number(event.target.value))
                      }
                    >
                      {timeline.map(({ year }) => (
                        <option key={year} value={year}>
                          {year}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="citation-year-chart">
                  {timeline.map(({ year, count }) => (
                    <button
                      className={
                        selectedYearRange &&
                        year >= selectedYearRange[0] &&
                        year <= selectedYearRange[1]
                          ? "active"
                          : ""
                      }
                      key={year}
                      type="button"
                      title={`${year}: ${count} 篇论文`}
                      onClick={() =>
                        setSelectedYearRange((current) =>
                          current?.[0] === year && current[1] === year
                            ? undefined
                            : [year, year],
                        )
                      }
                    >
                      <small>{year}</small>
                      <span className="citation-year-bar" aria-hidden="true">
                        <span
                          style={{
                            width: `${Math.max(
                              5,
                              Math.min(112, count * 6),
                            )}px`,
                          }}
                        />
                      </span>
                      <strong>{count}</strong>
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>

          <div className="citation-filter-footer">
            <Database size={14} />
            OpenAlex
            <span>{snapshot.updatedAt ? "已缓存" : "待刷新"}</span>
          </div>
        </aside>

        <main className="citation-browser-canvas citation-graph-canvas">
          <div className="citation-canvas-caption">
            <div>
              <span>引文网络</span>
              <strong>
                {visibleSnapshot.nodes.length} 个节点 ·{" "}
                {visibleSnapshot.edges.length} 条关系
              </strong>
            </div>
            {selectedYearLabel && (
              <button
                type="button"
                onClick={() => setSelectedYearRange(undefined)}
              >
                {selectedYearLabel} <X size={13} />
              </button>
            )}
          </div>

          {loading ? (
            <EmptyGraphState
              icon={<LoaderCircle className="spin" size={24} />}
              title="正在载入图谱"
              description="正在读取已同步的引文关系。"
            />
          ) : selectedPaperIdList.length === 0 ? (
            <EmptyGraphState
              icon={<FolderOpen size={34} />}
              title="先选择需要分析的论文"
              description="在左侧展开本地文献，勾选一篇或多篇论文后，再点击右上角刷新构建引文网络。"
            />
          ) : scopedSnapshot.nodes.length === 0 ||
            scopedSnapshot.edges.length === 0 ? (
            <EmptyGraphState
              icon={<Network size={34} />}
              title="建立论文之间的关系"
              description="刷新后会结合 OpenAlex 与 PDF 文末编号书目补齐参考文献，并获取引用本文的高被引论文。"
              action={
                <button
                  className="citation-empty-refresh"
                  type="button"
                  disabled={refreshing || selectedPaperIdList.length === 0}
                  onClick={() => void refresh(false)}
                >
                  <RefreshCw size={15} />
                  刷新图谱
                </button>
              }
            />
          ) : flow.nodes.length === 0 ? (
            <EmptyGraphState
              icon={<Filter size={30} />}
              title="当前筛选条件没有匹配的论文"
              description="调整左侧的数据源、关系或时间范围，重新显示图谱节点。"
              action={
                <button
                  className="citation-empty-refresh"
                  type="button"
                  onClick={() => {
                    setShowLocal(true);
                    setShowExternal(true);
                    setShowReferences(true);
                    setShowCiting(true);
                    setSelectedYearRange(undefined);
                  }}
                >
                  重置筛选
                </button>
              }
            />
          ) : (
            <ReactFlow
              nodes={flow.nodes}
              edges={flow.edges}
              nodeTypes={nodeTypes}
              minZoom={0.2}
              maxZoom={1.8}
              fitView
              fitViewOptions={{ padding: 0.16, duration: 0 }}
              nodesDraggable
              nodesConnectable={false}
              elementsSelectable
              onNodeClick={(_event, node) => openDetails(node.id)}
              onPaneClick={closeDetails}
            >
              <Background color="#dfe5e3" gap={26} size={1} />
              <Controls showInteractive={false} />
              <MiniMap
                className="citation-graph-minimap"
                nodeColor={(node) =>
                  (node.data as CitationNodeData).citation.kind === "library"
                    ? "#247c70"
                    : "#5aa59e"
                }
                maskColor="rgba(233, 239, 237, 0.68)"
              />
            </ReactFlow>
          )}

          <div className="citation-canvas-key" aria-label="图例">
            <span>
              <i className="local" />
              本地资料库
            </span>
            <span>
              <i className="reference" />
              参考文献
            </span>
            <span>
              <i className="citing" />
              引用本文
            </span>
          </div>
        </main>
      </div>

      {selected && !detailMinimized && (
        <aside
          className="citation-browser-details citation-detail-popover citation-graph-inspector"
          style={{
            left: detailPosition.left,
            top: detailPosition.top,
            maxHeight: Math.max(
              detailPanelMinHeight,
              window.innerHeight - detailPosition.top - 16,
            ),
          }}
          role="dialog"
          aria-label="论文详情"
        >
          <header
            className="citation-detail-window-header"
            onPointerDown={startDetailDrag}
            onPointerMove={moveDetailPanel}
            onPointerUp={stopDetailDrag}
            onPointerCancel={stopDetailDrag}
          >
            <div className="citation-detail-window-title">
              <span className="citation-detail-window-icon">
                <BookOpen size={16} />
              </span>
              <div>
                <strong>论文详情</strong>
                <small>
                  {selected.kind === "library" ? "本地资料库" : "外部文献"}
                </small>
              </div>
            </div>
            <div className="citation-detail-window-actions">
              <button
                className="icon-button"
                type="button"
                title="最小化论文详情"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setDetailMinimized(true)}
              >
                <Minus size={16} />
              </button>
              <button
                className="icon-button"
                type="button"
                title="关闭论文详情"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={closeDetails}
              >
                <X size={16} />
              </button>
            </div>
          </header>

          <div className="citation-detail-summary">
            <span className={`citation-detail-kind ${selected.kind}`}>
              {selected.kind === "library" ? "本地资料库" : "外部文献"}
            </span>
            <h3>{selected.title}</h3>
            <p className="citation-detail-authors">
              {selected.authors.length
                ? selected.authors.slice(0, 5).join(", ")
                : "作者未知"}
            </p>
          </div>

          <div className="citation-detail-tabs" role="tablist">
            <DetailTabButton
              active={activeTab === "details"}
              label="详情"
              onClick={() => setActiveTab("details")}
            />
            <DetailTabButton
              active={activeTab === "abstract"}
              label="摘要"
              onClick={() => setActiveTab("abstract")}
            />
            <DetailTabButton
              active={activeTab === "notes"}
              label="笔记"
              onClick={() => setActiveTab("notes")}
            />
            <DetailTabButton
              active={activeTab === "relations"}
              label="关系"
              onClick={() => setActiveTab("relations")}
            />
          </div>

          <div className="citation-detail-content">
            {activeTab === "details" && (
              <DetailOverview
                selected={selected}
                copied={copied}
                onCopyDoi={() => void copyDoi()}
              />
            )}
            {activeTab === "abstract" && (
              <DetailTextState
                title="摘要"
                content={selectedPaper?.abstract ?? selected.abstract}
                empty={
                  selectedPaper
                    ? "当前资料库没有这篇论文的摘要。"
                    : "OpenAlex 当前没有提供这篇论文的摘要。"
                }
              />
            )}
            {activeTab === "notes" && (
              <DetailNotes
                content={noteContent}
                loading={noteLoading}
                enabled={Boolean(selectedPaper)}
              />
            )}
            {activeTab === "relations" && (
              <RelatedPapers
                selected={selected}
                relatedNodes={relatedNodes}
                onSelect={openDetails}
              />
            )}
          </div>

          <footer className="citation-detail-actions">
            {(selected.sourceUrl ||
              selected.doi ||
              selectedPaper?.sourceUrl) && (
              <button
                className="citation-source-action"
                type="button"
                onClick={openSelectedSource}
              >
                <ExternalLink size={15} />
                打开来源
              </button>
            )}
            {selectedPaper ? (
              <button
                className="citation-library-action"
                type="button"
                onClick={() => onOpenPaper(selectedPaper.id)}
              >
                <FolderOpen size={15} />
                在资料库中打开
              </button>
            ) : selected.doi ? (
              <button
                className="citation-library-action"
                type="button"
                disabled={importing}
                onClick={() => void importSelected()}
              >
                {importing ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <FilePlus2 size={15} />
                )}
                导入到资料库
              </button>
            ) : null}
          </footer>
        </aside>
      )}

      {selected && detailMinimized && (
        <button
          className="citation-detail-minimized"
          type="button"
          title="恢复论文详情"
          aria-label="恢复论文详情"
          onClick={() => setDetailMinimized(false)}
        >
          <span className="citation-detail-window-icon">
            <BookOpen size={15} />
          </span>
          <span>{selected.title}</span>
          <Maximize2 size={13} />
        </button>
      )}
    </section>
  );
}

function DetailTabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      className={active ? "active" : ""}
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function DetailOverview({
  selected,
  copied,
  onCopyDoi,
}: {
  selected: CitationGraphNode;
  copied: boolean;
  onCopyDoi: () => void;
}): React.JSX.Element {
  return (
    <>
      <dl className="citation-detail-metadata">
        <div>
          <dt>年份</dt>
          <dd>{selected.year ?? "未知"}</dd>
        </div>
        <div>
          <dt>来源</dt>
          <dd>{selected.journal ?? "未知"}</dd>
        </div>
        <div>
          <dt>被引次数</dt>
          <dd>{selected.citedByCount.toLocaleString()}</dd>
        </div>
        {selected.openAlexId && (
          <div>
            <dt>OpenAlex</dt>
            <dd>{selected.openAlexId}</dd>
          </div>
        )}
      </dl>
      {selected.doi && (
        <button
          className="citation-detail-doi"
          type="button"
          title="复制 DOI"
          onClick={onCopyDoi}
        >
          <span>
            <small>DOI</small>
            {selected.doi}
          </span>
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button>
      )}
      <div className="citation-detail-relation-pills">
        {selected.referencedByLibrary && (
          <span className="reference">
            <ArrowDownLeft size={13} />
            被库内论文参考
          </span>
        )}
        {selected.citesLibrary && (
          <span className="citing">
            <ArrowUpRight size={13} />
            引用库内论文
          </span>
        )}
      </div>
    </>
  );
}

function DetailTextState({
  title,
  content,
  empty,
}: {
  title: string;
  content?: string;
  empty: string;
}): React.JSX.Element {
  return content?.trim() ? (
    <article className="citation-detail-prose">
      <span>{title}</span>
      <p>{content}</p>
    </article>
  ) : (
    <div className="citation-detail-tab-empty">
      <FileText size={20} />
      <p>{empty}</p>
    </div>
  );
}

function DetailNotes({
  content,
  loading,
  enabled,
}: {
  content: string;
  loading: boolean;
  enabled: boolean;
}): React.JSX.Element {
  if (!enabled) {
    return (
      <div className="citation-detail-tab-empty">
        <BookOpen size={20} />
        <p>导入这篇论文后，可以在此查看资料库笔记。</p>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="citation-detail-tab-empty">
        <LoaderCircle className="spin" size={20} />
        <p>正在读取笔记。</p>
      </div>
    );
  }
  return (
    <DetailTextState
      title="研究笔记"
      content={content}
      empty="这篇论文还没有笔记。"
    />
  );
}

function RelatedPapers({
  selected,
  relatedNodes,
  onSelect,
}: {
  selected: CitationGraphNode;
  relatedNodes: Array<{
    node: CitationGraphNode;
    relation: "references" | "citedBy";
  }>;
  onSelect: (nodeId: string) => void;
}): React.JSX.Element {
  if (!relatedNodes.length) {
    return (
      <div className="citation-detail-tab-empty">
        <Link2 size={20} />
        <p>当前筛选范围内没有与此论文相连的节点。</p>
      </div>
    );
  }
  return (
    <div className="citation-related-list">
      {relatedNodes.map(({ node, relation }) => (
        <button
          key={node.id}
          type="button"
          onClick={() => onSelect(node.id)}
          title={`查看 ${node.title}`}
        >
          {relation === "references" ? (
            <ArrowDownLeft size={14} />
          ) : (
            <ArrowUpRight size={14} />
          )}
          <span>
            <strong>{node.title}</strong>
            <small>
              {relation === "references"
                ? `${selected.title} 参考了此论文`
                : `此论文引用了 ${selected.title}`}
            </small>
          </span>
        </button>
      ))}
    </div>
  );
}

export function scopeCitationSnapshot(
  snapshot: CitationGraphSnapshot,
  selectedPaperIds: ReadonlySet<string>,
): CitationGraphSnapshot {
  if (selectedPaperIds.size === 0) {
    return {
      nodes: [],
      edges: [],
      updatedAt: snapshot.updatedAt,
      errors: [...snapshot.errors],
    };
  }

  const selectedNodeIds = new Set(
    [...selectedPaperIds].map((paperId) => `paper:${paperId}`),
  );
  const edges = snapshot.edges.filter(
    (edge) =>
      selectedNodeIds.has(edge.source) || selectedNodeIds.has(edge.target),
  );
  const visibleNodeIds = new Set(selectedNodeIds);
  const relations = new Map<
    string,
    { referencedByLibrary: boolean; citesLibrary: boolean }
  >();

  for (const edge of edges) {
    visibleNodeIds.add(edge.source);
    visibleNodeIds.add(edge.target);
    if (selectedNodeIds.has(edge.source) && !selectedNodeIds.has(edge.target)) {
      const relation = relations.get(edge.target) ?? {
        referencedByLibrary: false,
        citesLibrary: false,
      };
      relation.referencedByLibrary = true;
      relations.set(edge.target, relation);
    }
    if (selectedNodeIds.has(edge.target) && !selectedNodeIds.has(edge.source)) {
      const relation = relations.get(edge.source) ?? {
        referencedByLibrary: false,
        citesLibrary: false,
      };
      relation.citesLibrary = true;
      relations.set(edge.source, relation);
    }
  }

  const nodes = snapshot.nodes
    .filter((node) => visibleNodeIds.has(node.id))
    .map((node): CitationGraphNode => {
      if (selectedNodeIds.has(node.id)) {
        return {
          ...node,
          kind: "library",
          referencedByLibrary: false,
          citesLibrary: false,
        };
      }
      const relation = relations.get(node.id);
      return {
        ...node,
        referencedByLibrary: relation?.referencedByLibrary ?? false,
        citesLibrary: relation?.citesLibrary ?? false,
      };
    });

  return {
    nodes,
    edges,
    updatedAt: snapshot.updatedAt,
    errors: [...snapshot.errors],
  };
}

export function markLibraryNodes(
  snapshot: CitationGraphSnapshot,
  papers: Paper[],
): CitationGraphSnapshot {
  const papersById = new Map(papers.map((paper) => [paper.id, paper]));
  const papersByDoi = new Map<string, Paper>();
  const papersByTitle = new Map<string, Paper[]>();

  for (const paper of papers) {
    const doi = normalizeCitationDoi(paper.doi);
    if (doi) papersByDoi.set(doi, paper);
    const title = normalizeLibraryTitle(paper.title);
    if (!title) continue;
    const matches = papersByTitle.get(title) ?? [];
    matches.push(paper);
    papersByTitle.set(title, matches);
  }

  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => {
      const doi = normalizeCitationDoi(node.doi);
      const titleMatches = papersByTitle.get(normalizeLibraryTitle(node.title));
      const titleMatch =
        titleMatches?.length === 1 &&
        (!node.year ||
          !titleMatches[0].year ||
          node.year === titleMatches[0].year)
          ? titleMatches[0]
          : undefined;
      const paper =
        (node.paperId ? papersById.get(node.paperId) : undefined) ??
        (doi ? papersByDoi.get(doi) : undefined) ??
        titleMatch;
      if (!paper) return node;
      return {
        ...node,
        kind: "library",
        paperId: paper.id,
        sourceUrl: paper.sourceUrl ?? node.sourceUrl,
      };
    }),
  };
}

function normalizeLibraryTitle(value: string): string {
  return formatCitationTitle(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function formatCitationTitle(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface PaperSelectionGroup {
  id: string;
  name: string;
  papers: Paper[];
  children: PaperSelectionGroup[];
}

function buildPaperGroups(
  papers: Paper[],
  folders: LibraryFolder[],
): PaperSelectionGroup[] {
  const papersByFolder = new Map<string | undefined, Paper[]>();
  for (const paper of papers) {
    const group = papersByFolder.get(paper.folderId) ?? [];
    group.push(paper);
    papersByFolder.set(paper.folderId, group);
  }
  const foldersByParent = new Map<string | undefined, LibraryFolder[]>();
  for (const folder of folders) {
    const group = foldersByParent.get(folder.parentId) ?? [];
    group.push(folder);
    foldersByParent.set(folder.parentId, group);
  }

  const buildFolder = (folder: LibraryFolder): PaperSelectionGroup => ({
    id: `folder:${folder.id}`,
    name: folder.name,
    papers: (papersByFolder.get(folder.id) ?? []).sort((first, second) =>
      first.title.localeCompare(second.title),
    ),
    children: (foldersByParent.get(folder.id) ?? [])
      .map(buildFolder)
      .filter((group) => group.papers.length > 0 || group.children.length > 0)
      .sort((first, second) => first.name.localeCompare(second.name)),
  });

  const groups: PaperSelectionGroup[] = [];
  const folderIds = new Set(folders.map((folder) => folder.id));
  const unfiled = papers
    .filter((paper) => !paper.folderId || !folderIds.has(paper.folderId))
    .sort((first, second) => first.title.localeCompare(second.title));
  if (unfiled.length) {
    groups.push({
      id: "folder:unfiled",
      name: "未分类",
      papers: unfiled,
      children: [],
    });
  }
  groups.push(
    ...(foldersByParent.get(undefined) ?? [])
      .map(buildFolder)
      .filter((group) => group.papers.length > 0 || group.children.length > 0)
      .sort((first, second) => first.name.localeCompare(second.name)),
  );
  return groups;
}

function PaperSelectionGroup({
  group,
  selectedPaperIds,
  onTogglePaper,
  onToggleGroup,
  depth = 0,
}: {
  group: PaperSelectionGroup;
  selectedPaperIds: Set<string>;
  onTogglePaper: (paperId: string) => void;
  onToggleGroup: (paperIds: string[]) => void;
  depth?: number;
}): React.JSX.Element {
  const [open, setOpen] = useState(depth < 1);
  const paperIds = [
    ...group.papers.map((paper) => paper.id),
    ...group.children.flatMap((child) => getGroupPaperIds(child)),
  ];
  const allSelected =
    paperIds.length > 0 &&
    paperIds.every((paperId) => selectedPaperIds.has(paperId));
  const selectedCount = paperIds.filter((paperId) =>
    selectedPaperIds.has(paperId),
  ).length;

  return (
    <div className="citation-paper-group" style={{ paddingLeft: depth * 9 }}>
      <div className="citation-paper-group-row">
        <button
          className="citation-paper-group-expand"
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-label={open ? "折叠文件夹" : "展开文件夹"}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <input
          type="checkbox"
          checked={allSelected}
          disabled={!paperIds.length}
          onChange={() => onToggleGroup(paperIds)}
          aria-label={`选择文件夹 ${group.name}`}
        />
        <FolderOpen size={14} />
        <span title={group.name}>{group.name}</span>
        <small>
          {selectedCount}/{paperIds.length}
        </small>
      </div>
      {open && (
        <div className="citation-paper-group-contents">
          {group.papers.map((paper) => (
            <label className="citation-paper-selection" key={paper.id}>
              <input
                type="checkbox"
                checked={selectedPaperIds.has(paper.id)}
                onChange={() => onTogglePaper(paper.id)}
              />
              <FileText size={12} />
              <span title={paper.title}>{paper.title}</span>
            </label>
          ))}
          {group.children.map((child) => (
            <PaperSelectionGroup
              key={child.id}
              group={child}
              selectedPaperIds={selectedPaperIds}
              onTogglePaper={onTogglePaper}
              onToggleGroup={onToggleGroup}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function getGroupPaperIds(group: PaperSelectionGroup): string[] {
  return [
    ...group.papers.map((paper) => paper.id),
    ...group.children.flatMap((child) => getGroupPaperIds(child)),
  ];
}

function EmptyGraphState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.JSX.Element;
  title: string;
  description: string;
  action?: React.JSX.Element;
}): React.JSX.Element {
  return (
    <div className="citation-empty-state">
      {icon}
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

function CitationNode({
  data,
  selected,
}: NodeProps<CitationFlowNode>): React.JSX.Element {
  const node = data.citation;
  const relationClass =
    node.kind === "library"
      ? "library"
      : node.referencedByLibrary && node.citesLibrary
        ? "both"
        : node.referencedByLibrary
          ? "reference"
          : "citing";
  return (
    <div
      className={`citation-flow-node ${relationClass} ${
        selected ? "selected" : ""
      } ${data.dimmed ? "dimmed" : ""}`}
    >
      <Handle type="target" position={Position.Left} />
      <strong title={formatCitationTitle(node.title)}>
        {formatCitationTitle(node.title)}
      </strong>
      <div className="citation-flow-node-meta">
        <span>{node.year ?? "年份未知"}</span>
        <span>被引 {node.citedByCount.toLocaleString()}</span>
        <span className="citation-flow-node-author">
          {node.authors[0] ?? node.journal ?? "作者未知"}
        </span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function buildFlowGraph(
  citationNodes: CitationGraphNode[],
  citationEdges: CitationGraphSnapshot["edges"],
  query: string,
): { nodes: CitationFlowNode[]; edges: Edge[]; layoutKey: string } {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: "LR",
    nodesep: 12,
    ranksep: 50,
    marginx: 18,
    marginy: 18,
  });
  for (const node of citationNodes) {
    graph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  }
  for (const edge of citationEdges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const nodeById = new Map(citationNodes.map((node) => [node.id, node]));
  return {
    nodes: citationNodes.map((citation) => {
      const position = graph.node(citation.id);
      const haystack = [
        citation.title,
        citation.doi,
        citation.journal,
        ...citation.authors,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      return {
        id: citation.id,
        type: "citation",
        position: {
          x: position.x - nodeWidth / 2,
          y: position.y - nodeHeight / 2,
        },
        data: {
          citation,
          dimmed: Boolean(
            normalizedQuery && !haystack.includes(normalizedQuery),
          ),
        },
      };
    }),
    edges: citationEdges.map((edge) => {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      const color =
        source?.kind === "library" && target?.kind === "external"
          ? "#d19732"
          : source?.kind === "external" && target?.kind === "library"
            ? "#388d87"
            : "#7f8b85";
      return {
        ...edge,
        type: "smoothstep",
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color,
        },
        style: { stroke: color, strokeWidth: 1.35 },
      };
    }),
    layoutKey: `${citationNodes.map((node) => node.id).join("|")}:${citationEdges
      .map((edge) => edge.id)
      .join("|")}`,
  };
}

function getRelatedNodes(
  selected: CitationGraphNode,
  snapshot: CitationGraphSnapshot,
): Array<{
  node: CitationGraphNode;
  relation: "references" | "citedBy";
}> {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const related: Array<{
    node: CitationGraphNode;
    relation: "references" | "citedBy";
  }> = [];
  for (const edge of snapshot.edges) {
    if (edge.source === selected.id) {
      const node = byId.get(edge.target);
      if (node) related.push({ node, relation: "references" });
    }
    if (edge.target === selected.id) {
      const node = byId.get(edge.source);
      if (node) related.push({ node, relation: "citedBy" });
    }
  }
  return related;
}

function CircleErrorText({ errors }: { errors: string[] }): React.JSX.Element {
  return (
    <div>
      <strong>部分论文同步失败</strong>
      <span title={errors.join("\n")}>
        {errors[0]}
        {errors.length > 1 ? `，另有 ${errors.length - 1} 项` : ""}
      </span>
    </div>
  );
}
