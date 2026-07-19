import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
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
  type Viewport,
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
  Braces,
  ChartNetwork,
  Compass,
  Database,
  Download,
  ExternalLink,
  FileCode2,
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
  CitationDiscoveryMode,
  CitationDiscoveryResult,
  CitationGraphNode,
  CitationGraphSnapshot,
  CitationGraphExportFormat,
  CitationMatchStatus,
  CitationMetadataSource,
  CitationNetworkAnalysis,
  LibraryFolder,
  Paper,
} from "../../shared/contracts";
import {
  CITATION_GRAPH_EXTERNAL_NODE_MAX,
  CITATION_GRAPH_FOCUSED_EXTERNAL_NODE_MAX,
  limitCitationGraphExternalNodes,
  normalizeCitationDoi,
} from "../../shared/citationGraph";
import {
  CITATION_DISCOVERY_MAX_CANDIDATES,
  CITATION_DISCOVERY_PURE_SEARCH_MAX_CANDIDATES,
} from "../../shared/citationDiscovery";
import { CitationAnalysisPanel } from "./CitationAnalysisPanel";
import { CitationDiscoveryPanel } from "./CitationDiscoveryPanel";
import {
  buildCitationGraphExportDocument,
  buildCitationGraphExportScene,
  buildCitationGraphInteractiveHtml,
  serializeCitationGraphExportDocument,
} from "./citationGraphExport";

interface CitationGraphWorkspaceProps {
  papers: Paper[];
  folders: LibraryFolder[];
  sidebarWidth: number;
  sidebarMinWidth: number;
  sidebarMaxWidth: number;
  onSidebarResizePointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onSidebarResizeKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onOpenPaper: (paperId: string) => void;
  onOpenSettings: () => void;
  onError: (message: string) => void;
}

interface CitationNodeData extends Record<string, unknown> {
  citation: CitationGraphNode;
  dimmed: boolean;
}

type CitationFlowNode = Node<CitationNodeData, "citation">;
type DetailTab = "details" | "abstract" | "notes" | "relations";
type CitationWorkspaceView = "graph" | "discovery" | "analysis";

interface DetailPanelPosition {
  left: number;
  top: number;
}

interface SavedGraphViewport {
  layoutKey: string;
  viewport: Viewport;
}

interface ExternalNodeLimits {
  references: number;
  citing: number;
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
  sidebarWidth,
  sidebarMinWidth,
  sidebarMaxWidth,
  onSidebarResizePointerDown,
  onSidebarResizeKeyDown,
  onOpenPaper,
  onOpenSettings,
  onError,
}: CitationGraphWorkspaceProps): React.JSX.Element {
  const { fitView, getViewport, setViewport } = useReactFlow();
  const [snapshot, setSnapshot] = useState<CitationGraphSnapshot>({
    nodes: [],
    edges: [],
    errors: [],
  });
  const [viewMode, setViewMode] = useState<CitationWorkspaceView>("graph");
  const [graphDepth, setGraphDepth] = useState<1 | 2>(1);
  const [expandingTwoHop, setExpandingTwoHop] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [discoveryQuery, setDiscoveryQuery] = useState("");
  const [discoveryMode, setDiscoveryMode] =
    useState<CitationDiscoveryMode>("contextual");
  const [discoveryResult, setDiscoveryResult] =
    useState<CitationDiscoveryResult>();
  const [analysis, setAnalysis] = useState<CitationNetworkAnalysis>();
  const [analysisFocusIds, setAnalysisFocusIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [exporting, setExporting] = useState<CitationGraphExportFormat>();
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [localPickerOpen, setLocalPickerOpen] = useState(true);
  const [selectedPaperIds, setSelectedPaperIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [showLocal, setShowLocal] = useState(true);
  const [showExternal, setShowExternal] = useState(true);
  const [showReferences, setShowReferences] = useState(true);
  const [showCiting, setShowCiting] = useState(true);
  const [externalNodeLimits, setExternalNodeLimits] =
    useState<ExternalNodeLimits>({
      references: CITATION_GRAPH_EXTERNAL_NODE_MAX,
      citing: CITATION_GRAPH_EXTERNAL_NODE_MAX,
    });
  const [selectedYearRange, setSelectedYearRange] =
    useState<[number, number]>();
  const [timelineOpen, setTimelineOpen] = useState(true);
  const externalNodeMax =
    graphDepth === 2
      ? CITATION_GRAPH_FOCUSED_EXTERNAL_NODE_MAX
      : CITATION_GRAPH_EXTERNAL_NODE_MAX;
  const activeExternalNodeLimits = useMemo(
    () => ({
      references: Math.min(externalNodeLimits.references, externalNodeMax),
      citing: Math.min(externalNodeLimits.citing, externalNodeMax),
    }),
    [externalNodeLimits, externalNodeMax],
  );
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
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const fittedLayoutKeyRef = useRef<string | undefined>(undefined);
  const savedGraphViewportRef = useRef<SavedGraphViewport | undefined>(
    undefined,
  );
  const detailDragRef = useRef<
    | {
        pointerId: number;
        offsetX: number;
        offsetY: number;
      }
    | undefined
  >(undefined);

  useEffect(() => {
    const clearSnapshot = (): void => {
      setSnapshot({ nodes: [], edges: [], errors: [] });
      setGraphDepth(1);
      setDiscoveryResult(undefined);
      setAnalysis(undefined);
      setAnalysisFocusIds(new Set());
      setSelectedId(undefined);
      setDetailMinimized(false);
    };
    window.addEventListener(
      "paperxcel:citation-graph-cache-cleared",
      clearSnapshot,
    );
    return () => {
      window.removeEventListener(
        "paperxcel:citation-graph-cache-cleared",
        clearSnapshot,
      );
    };
  }, []);

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
      setAnalysis(undefined);
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

  const expandFocusedTwoHop = async (force = false): Promise<void> => {
    if (expandingTwoHop || selectedPaperIdList.length !== 1) {
      if (selectedPaperIdList.length !== 1) {
        onError("同向二重图谱需要先选择一篇论文。");
      }
      return;
    }
    setExpandingTwoHop(true);
    try {
      const result = await window.paperxcel.citationGraph.expand(
        selectedPaperIdList[0],
        force,
      );
      if (selectionScopeRef.current !== selectionScopeKey) return;
      setSnapshot(result.snapshot);
      setGraphDepth(2);
      setAnalysis(undefined);
      setAnalysisFocusIds(new Set());
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setExpandingTwoHop(false);
    }
  };

  const switchGraphDepth = (nextDepth: 1 | 2): void => {
    if (nextDepth === graphDepth) return;
    if (nextDepth === 2) {
      void expandFocusedTwoHop();
      return;
    }
    setGraphDepth(1);
    setSnapshot({ nodes: [], edges: [], errors: [] });
    setAnalysis(undefined);
    setAnalysisFocusIds(new Set());
    void loadSnapshot();
  };

  const discover = async (
    mode: CitationDiscoveryMode = discoveryMode,
  ): Promise<void> => {
    if (discovering) return;
    if (mode === "pure-search" && !discoveryQuery.trim()) {
      onError("纯搜索需要输入主题关键词。");
      return;
    }
    if (mode === "contextual" && selectedPaperIdList.length === 0) return;
    const requestedScope = selectionScopeKey;
    setDiscoveryMode(mode);
    setDiscovering(true);
    try {
      const result = await window.paperxcel.citationGraph.discover({
        paperIds: mode === "pure-search" ? [] : selectedPaperIdList,
        query: discoveryQuery,
        limit:
          mode === "pure-search"
            ? CITATION_DISCOVERY_PURE_SEARCH_MAX_CANDIDATES
            : CITATION_DISCOVERY_MAX_CANDIDATES,
        mode,
      });
      if (
        mode === "pure-search" ||
        selectionScopeRef.current === requestedScope
      ) {
        setDiscoveryResult(result);
      }
    } catch (error) {
      if (
        mode === "pure-search" ||
        selectionScopeRef.current === requestedScope
      ) {
        onError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setDiscovering(false);
    }
  };

  const openGoogleScholar = (): void => {
    const scholarQuery = discoveryResult?.query.trim() || discoveryQuery.trim();
    if (!scholarQuery) {
      onError("请先输入主题关键词，再打开 Google Scholar。");
      return;
    }
    void window.paperxcel.citationGraph
      .openGoogleScholar(scholarQuery)
      .catch((error: unknown) => {
        onError(error instanceof Error ? error.message : String(error));
      });
  };

  const analyze = useCallback(async (): Promise<void> => {
    if (analyzing || selectedPaperIdList.length === 0) return;
    const requestedScope = selectionScopeKey;
    setAnalyzing(true);
    try {
      const result = await window.paperxcel.citationGraph.analyze(
        selectedPaperIdList,
        {
          mode: graphDepth === 2 ? "focused-two-hop" : "standard",
          externalLimits: activeExternalNodeLimits,
        },
      );
      if (selectionScopeRef.current === requestedScope) {
        setAnalysis(result);
      }
    } catch (error) {
      if (selectionScopeRef.current === requestedScope) {
        onError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setAnalyzing(false);
    }
  }, [
    analyzing,
    activeExternalNodeLimits,
    graphDepth,
    onError,
    selectedPaperIdList,
    selectionScopeKey,
  ]);

  useEffect(() => {
    if (
      viewMode === "analysis" &&
      selectedPaperIdList.length > 0 &&
      !analysis &&
      !analyzing
    ) {
      void analyze();
    }
  }, [analysis, analyze, analyzing, selectedPaperIdList.length, viewMode]);

  const updateSelectedPaperIds = (next: Set<string>): void => {
    selectionScopeRef.current = papers
      .filter((paper) => next.has(paper.id))
      .map((paper) => paper.id)
      .join("\u0000");
    setSelectedPaperIds(next);
    setGraphDepth(1);
    setSnapshot({ nodes: [], edges: [], errors: [] });
    setDiscoveryResult(undefined);
    setAnalysis(undefined);
    setAnalysisFocusIds(new Set());
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
        snapshot.graphMode === "focused-two-hop"
          ? snapshot
          : scopeCitationSnapshot(snapshot, selectedPaperIds),
        papers,
      ),
    [papers, selectedPaperIds, snapshot],
  );

  useEffect(() => {
    if (
      selectedId &&
      !scopedSnapshot.nodes.some((node) => node.id === selectedId) &&
      !discoveryResult?.candidates.some(
        (candidate) => candidate.work.id === selectedId,
      )
    ) {
      setSelectedId(undefined);
      setDetailMinimized(false);
    }
  }, [discoveryResult, scopedSnapshot.nodes, selectedId]);

  const selected =
    scopedSnapshot.nodes.find((node) => node.id === selectedId) ??
    discoveryResult?.candidates.find(
      (candidate) => candidate.work.id === selectedId,
    )?.work;
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

  const updateExternalNodeLimit = (
    side: keyof ExternalNodeLimits,
    value: number,
  ): void => {
    setExternalNodeLimits((current) => {
      if (current[side] === value) return current;
      return { ...current, [side]: value };
    });
    // 外部节点数量会改变分析输入，旧分析结果不能继续复用。
    setAnalysis(undefined);
    setAnalysisFocusIds(new Set());
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
    const filteredSnapshot: CitationGraphSnapshot = {
      ...scopedSnapshot,
      nodes: scopedSnapshot.nodes.filter((node) => visibleIds.has(node.id)),
      edges: scopedSnapshot.edges.filter(
        (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
      ),
    };
    return limitCitationGraphExternalNodes(
      filteredSnapshot,
      activeExternalNodeLimits,
      externalNodeMax,
    );
  }, [
    activeExternalNodeLimits,
    externalNodeMax,
    selectedYearRange,
    showCiting,
    showExternal,
    showLocal,
    showReferences,
    scopedSnapshot,
  ]);

  const analysisSnapshot = useMemo(
    () =>
      limitCitationGraphExternalNodes(
        scopedSnapshot,
        activeExternalNodeLimits,
        externalNodeMax,
      ),
    [activeExternalNodeLimits, externalNodeMax, scopedSnapshot],
  );

  const flow = useMemo(
    () =>
      buildFlowGraph(
        visibleSnapshot.nodes,
        visibleSnapshot.edges,
        query,
        analysisFocusIds,
      ),
    [analysisFocusIds, query, visibleSnapshot.edges, visibleSnapshot.nodes],
  );

  useLayoutEffect(() => {
    if (viewMode !== "graph") return;
    const saved = savedGraphViewportRef.current;
    if (!saved || saved.layoutKey !== flow.layoutKey) return;
    const frame = window.requestAnimationFrame(() => {
      void setViewport(saved.viewport, { duration: 0 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [flow.layoutKey, setViewport, viewMode]);

  useEffect(() => {
    if (!exportMenuOpen) return;
    const closeOnPointerDown = (event: globalThis.PointerEvent): void => {
      if (
        event.target instanceof Node &&
        exportMenuRef.current?.contains(event.target)
      ) {
        return;
      }
      setExportMenuOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") setExportMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [exportMenuOpen]);

  useEffect(() => {
    if (
      viewMode !== "graph" ||
      !flow.nodes.length ||
      fittedLayoutKeyRef.current === flow.layoutKey
    ) {
      return;
    }
    fittedLayoutKeyRef.current = flow.layoutKey;
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
  }, [fitView, flow.layoutKey, flow.nodes.length, viewMode]);

  useEffect(() => {
    let timeout: number | undefined;
    const handleResize = (): void => {
      if (viewMode !== "graph") return;
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
  }, [fitView, viewMode]);

  const copyDoi = async (): Promise<void> => {
    if (!selected?.doi) return;
    await window.paperxcel.clipboard.writeText(selected.doi);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  const exportGraph = async (
    format: CitationGraphExportFormat,
  ): Promise<void> => {
    if (exporting || !flow.nodes.length) return;
    setExportMenuOpen(false);
    setExporting(format);
    try {
      const exportedAt = new Date();
      const filterLabels = [
        selectedScopeLabel,
        selectedYearLabel ? `年份 ${selectedYearLabel}` : undefined,
        query.trim() ? `搜索“${query.trim()}”` : undefined,
      ].filter((label): label is string => Boolean(label));
      const document = buildCitationGraphExportDocument({
        exportedAt: exportedAt.toISOString(),
        title: "PaperXcel 引文图谱",
        subtitle: `${visibleSnapshot.nodes.length} 个节点 · ${visibleSnapshot.edges.length} 条关系 · ${filterLabels.join(" · ")}`,
        sourceUpdatedAt: snapshot.updatedAt,
        graphMode: snapshot.graphMode,
        focusedPaperId: snapshot.focusedPaperId,
        expansion: snapshot.expansion,
        filters: {
          selectedPaperIds: selectedPaperIdList,
          selectedScopeLabel,
          yearRange: selectedYearRange,
          query,
          showLocal,
          showExternal,
          showReferences,
          showCiting,
        },
        nodes: flow.nodes.map((node) => ({
          id: node.id,
          x: node.position.x,
          y: node.position.y,
          width: nodeWidth,
          height: nodeHeight,
          citation: node.data.citation,
          dimmed: node.data.dimmed,
        })),
        edges: visibleSnapshot.edges,
        errors: snapshot.errors,
      });
      const scene = buildCitationGraphExportScene(document);
      const content =
        format === "json"
          ? serializeCitationGraphExportDocument(document)
          : buildCitationGraphInteractiveHtml(document, scene);
      await window.paperxcel.citationGraph.export({ format, content });
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(undefined);
    }
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

  const changeViewMode = (nextViewMode: CitationWorkspaceView): void => {
    if (viewMode === "graph" && nextViewMode !== "graph") {
      savedGraphViewportRef.current = {
        layoutKey: flow.layoutKey,
        viewport: getViewport(),
      };
    }
    setViewMode(nextViewMode);
  };

  const focusGraphNodes = (nodeIds: string[]): void => {
    setAnalysisFocusIds(new Set(nodeIds));
    setShowLocal(true);
    setShowExternal(true);
    setShowReferences(true);
    setShowCiting(true);
    setSelectedYearRange(undefined);
    changeViewMode("graph");
  };

  const selectAnalysisNode = (nodeId: string): void => {
    focusGraphNodes([nodeId]);
    setSelectedId(nodeId);
    setDetailMinimized(false);
  };

  const startDetailDrag = (event: React.PointerEvent<HTMLElement>): void => {
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

  const moveDetailPanel = (event: React.PointerEvent<HTMLElement>): void => {
    const drag = detailDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setDetailPosition(
      clampDetailPanelPosition({
        left: event.clientX - drag.offsetX,
        top: event.clientY - drag.offsetY,
      }),
    );
  };

  const stopDetailDrag = (event: React.PointerEvent<HTMLElement>): void => {
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
              {selectedScopeLabel} ·{" "}
              {viewMode === "graph"
                ? "OpenAlex / Crossref 引文网络"
                : viewMode === "discovery"
                  ? "外部论文发现"
                  : "引文网络分析"}
            </p>
          </div>
        </div>
        <div className="citation-browser-center">
          <div className="citation-workspace-tabs" role="tablist">
            <button
              className={viewMode === "graph" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={viewMode === "graph"}
              onClick={() => changeViewMode("graph")}
            >
              <Network size={14} />
              图谱
            </button>
            <button
              className={viewMode === "discovery" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={viewMode === "discovery"}
              onClick={() => changeViewMode("discovery")}
            >
              <Compass size={14} />
              发现
            </button>
            <button
              className={viewMode === "analysis" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={viewMode === "analysis"}
              onClick={() => changeViewMode("analysis")}
            >
              <ChartNetwork size={14} />
              分析
            </button>
          </div>
          {viewMode !== "analysis" && (
            <label className="citation-browser-search">
              <Search size={15} />
              <input
                value={viewMode === "graph" ? query : discoveryQuery}
                placeholder={
                  viewMode === "graph"
                    ? "搜索标题、作者、DOI 等"
                    : discoveryMode === "pure-search"
                      ? "输入主题关键词，空格或英文逗号分隔"
                      : "输入主题关键词，可留空使用选中文献"
                }
                aria-label={
                  viewMode === "graph" ? "搜索引文图谱" : "外部论文发现关键词"
                }
                onChange={(event) => {
                  if (viewMode === "graph") setQuery(event.target.value);
                  else setDiscoveryQuery(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (viewMode === "discovery" && event.key === "Enter") {
                    void discover();
                  }
                }}
              />
              {(viewMode === "graph" ? query : discoveryQuery) && (
                <button
                  type="button"
                  title="清除搜索"
                  onClick={() => {
                    if (viewMode === "graph") setQuery("");
                    else setDiscoveryQuery("");
                  }}
                >
                  <X size={14} />
                </button>
              )}
            </label>
          )}
        </div>
        <div className="citation-browser-header-actions">
          {viewMode === "graph" && (
            <div className="citation-graph-export" ref={exportMenuRef}>
              <button
                className="citation-browser-export-trigger"
                type="button"
                title="导出当前图谱"
                aria-haspopup="menu"
                aria-expanded={exportMenuOpen}
                disabled={Boolean(exporting) || flow.nodes.length === 0}
                onClick={() => setExportMenuOpen((open) => !open)}
              >
                {exporting ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <Download size={15} />
                )}
                导出
                <ChevronDown size={13} />
              </button>
              {exportMenuOpen && (
                <div className="citation-graph-export-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void exportGraph("json")}
                  >
                    <Braces size={16} />
                    JSON 数据
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void exportGraph("html")}
                  >
                    <FileCode2 size={16} />
                    交互式 HTML
                  </button>
                </div>
              )}
            </div>
          )}
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
            disabled={
              (viewMode === "discovery"
                ? selectedPaperIdList.length === 0
                : selectedPaperIdList.length === 0) ||
              (viewMode === "graph"
                ? refreshing || expandingTwoHop
                : viewMode === "discovery"
                  ? discovering
                  : analyzing)
            }
            onClick={() => {
              if (viewMode === "graph") {
                if (graphDepth === 2) void expandFocusedTwoHop(true);
                else void refresh(false);
              } else if (viewMode === "discovery") void discover("contextual");
              else void analyze();
            }}
          >
            {(viewMode === "graph" && (refreshing || expandingTwoHop)) ||
            (viewMode === "discovery" && discovering) ||
            (viewMode === "analysis" && analyzing) ? (
              <LoaderCircle className="spin" size={15} />
            ) : viewMode === "discovery" ? (
              <Compass size={15} />
            ) : viewMode === "analysis" ? (
              <ChartNetwork size={15} />
            ) : (
              <RefreshCw size={15} />
            )}
            {viewMode === "graph"
              ? "刷新"
              : viewMode === "discovery"
                ? "发现论文"
                : "重新分析"}
          </button>
          {viewMode === "discovery" && (
            <button
              className="citation-browser-pure-search"
              type="button"
              disabled={discovering || !discoveryQuery.trim()}
              title="只按主题关键词搜索，不读取本地论文和图谱缓存"
              onClick={() => void discover("pure-search")}
            >
              <Search size={15} />
              纯搜索
            </button>
          )}
        </div>
      </header>

      {viewMode === "graph" && snapshot.errors.length > 0 && (
        <div className="citation-browser-error">
          <CircleErrorText errors={snapshot.errors} />
          <button
            type="button"
            onClick={() =>
              graphDepth === 2
                ? void expandFocusedTwoHop(true)
                : void refresh(true)
            }
          >
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
          {viewMode === "graph" && (
            <>
              <p>引文网络视图</p>

              <section className="citation-filter-section citation-depth-section">
                <span className="citation-filter-label">图谱层级</span>
                <div className="citation-depth-switcher" role="group">
                  <button
                    type="button"
                    className={graphDepth === 1 ? "active" : ""}
                    onClick={() => switchGraphDepth(1)}
                  >
                    单层
                  </button>
                  <button
                    type="button"
                    className={graphDepth === 2 ? "active" : ""}
                    disabled={
                      selectedPaperIdList.length !== 1 || expandingTwoHop
                    }
                    title={
                      selectedPaperIdList.length === 1
                        ? "打开单篇论文的同向二重图谱"
                        : "同向二重图谱需要选择一篇论文"
                    }
                    onClick={() => switchGraphDepth(2)}
                  >
                    {expandingTwoHop ? (
                      <LoaderCircle className="spin" size={12} />
                    ) : null}
                    同向二重
                  </button>
                </div>
                {selectedPaperIdList.length !== 1 && (
                  <small className="citation-depth-hint">
                    同向二重图谱仅支持单篇目标论文
                  </small>
                )}
                {graphDepth === 2 && snapshot.expansion && (
                  <div className="citation-depth-summary">
                    <span>
                      参考 {snapshot.expansion.referenceFirstOrderCount}/
                      {snapshot.expansion.referenceSecondOrderCount}
                    </span>
                    <span>
                      引用 {snapshot.expansion.citingFirstOrderCount}/
                      {snapshot.expansion.citingSecondOrderCount}
                    </span>
                    {(snapshot.expansion.truncatedReferenceCount > 0 ||
                      snapshot.expansion.truncatedCitingCount > 0) && (
                      <small>
                        已截断{" "}
                        {snapshot.expansion.truncatedReferenceCount +
                          snapshot.expansion.truncatedCitingCount}
                        篇
                      </small>
                    )}
                  </div>
                )}
              </section>

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
                    onChange={(event) =>
                      setShowReferences(event.target.checked)
                    }
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

              <section className="citation-filter-section citation-external-limit-section">
                <div className="citation-external-limit-heading">
                  <span className="citation-filter-label">外部节点数量</span>
                  <small>
                    最多 {externalNodeMax} + {externalNodeMax}
                  </small>
                </div>
                <label className="citation-external-limit">
                  <span>
                    <span>参考文献</span>
                    <strong>{activeExternalNodeLimits.references}</strong>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={externalNodeMax}
                    step={1}
                    value={activeExternalNodeLimits.references}
                    aria-label="参考文献外部节点数量"
                    onChange={(event) =>
                      updateExternalNodeLimit(
                        "references",
                        Number(event.target.value),
                      )
                    }
                  />
                </label>
                <label className="citation-external-limit">
                  <span>
                    <span>引用本文</span>
                    <strong>{activeExternalNodeLimits.citing}</strong>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={externalNodeMax}
                    step={1}
                    value={activeExternalNodeLimits.citing}
                    aria-label="引用本文外部节点数量"
                    onChange={(event) =>
                      updateExternalNodeLimit(
                        "citing",
                        Number(event.target.value),
                      )
                    }
                  />
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
                          <span
                            className="citation-year-bar"
                            aria-hidden="true"
                          >
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
            </>
          )}

          {viewMode === "discovery" && (
            <>
              {discoveryResult && (
                <section className="citation-filter-section citation-research-sidebar">
                  <span className="citation-filter-label">本次结果</span>
                  <div>
                    <FileText size={14} />
                    <span>候选论文</span>
                    <small>{discoveryResult.candidates.length}</small>
                  </div>
                  <div>
                    <Database size={14} />
                    <span>内容关键词</span>
                    <small>{discoveryResult.terms.length}</small>
                  </div>
                </section>
              )}
            </>
          )}

          {viewMode === "analysis" && (
            <>
              <p>网络结构分析</p>
              <section className="citation-filter-section citation-research-sidebar">
                <span className="citation-filter-label">分析结果</span>
                <div>
                  <ChartNetwork size={14} />
                  <span>研究社区</span>
                  <small>{analysis?.metrics.communityCount ?? 0}</small>
                </div>
                <div>
                  <Link2 size={14} />
                  <span>文献耦合</span>
                  <small>{analysis?.bibliographicCoupling.length ?? 0}</small>
                </div>
                <div>
                  <Network size={14} />
                  <span>关键路径</span>
                  <small>{analysis?.keyPaths.length ?? 0}</small>
                </div>
              </section>
            </>
          )}

          <div className="citation-filter-footer">
            <Database size={14} />
            OpenAlex / Crossref / Europe PMC / arXiv
            <span>{snapshot.updatedAt ? "已缓存" : "待刷新"}</span>
          </div>
        </aside>

        <div
          className="panel-resize-handle citation-sidebar-resize-handle"
          role="separator"
          aria-label="调整引文图谱筛选栏宽度"
          aria-orientation="vertical"
          aria-valuemin={sidebarMinWidth}
          aria-valuemax={sidebarMaxWidth}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={onSidebarResizePointerDown}
          onKeyDown={onSidebarResizeKeyDown}
        />

        <main
          className={`citation-browser-canvas citation-graph-canvas citation-view-${viewMode}`}
        >
          {viewMode === "graph" ? (
            <>
              <div className="citation-canvas-caption">
                <div>
                  <span>{graphDepth === 2 ? "同向二重图谱" : "引文网络"}</span>
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
                {analysisFocusIds.size > 0 && (
                  <button
                    type="button"
                    onClick={() => setAnalysisFocusIds(new Set())}
                  >
                    高亮 {analysisFocusIds.size} 个节点 <X size={13} />
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
                  description="刷新后会结合 OpenAlex、Crossref 与 PDF 文末书目补齐并校验参考文献，同时获取引用本文的高被引论文。"
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
                  nodesDraggable
                  nodesConnectable={false}
                  elementsSelectable
                  onMoveEnd={(_event, viewport) => {
                    savedGraphViewportRef.current = {
                      layoutKey: flow.layoutKey,
                      viewport,
                    };
                  }}
                  onNodeClick={(_event, node) => openDetails(node.id)}
                  onPaneClick={closeDetails}
                >
                  <Background color="#dfe5e3" gap={26} size={1} />
                  <Controls showInteractive={false} />
                  <MiniMap
                    className="citation-graph-minimap"
                    nodeColor={(node) =>
                      (node.data as CitationNodeData).citation.kind ===
                      "library"
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
            </>
          ) : viewMode === "discovery" ? (
            <CitationDiscoveryPanel
              result={discoveryResult}
              mode={discoveryMode}
              loading={discovering}
              selectedPaperCount={selectedPaperIdList.length}
              onOpenDetails={(work) => openDetails(work.id)}
              onOpenSource={(sourceUrl) => window.open(sourceUrl, "_blank")}
              onOpenGoogleScholar={openGoogleScholar}
            />
          ) : (
            <CitationAnalysisPanel
              analysis={analysis}
              snapshot={analysisSnapshot}
              loading={analyzing}
              selectedPaperCount={selectedPaperIdList.length}
              onFocusNodes={focusGraphNodes}
              onSelectNode={selectAnalysisNode}
            />
          )}
        </main>
      </div>

      {viewMode !== "analysis" && selected && !detailMinimized && (
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
            ) : null}
          </footer>
        </aside>
      )}

      {viewMode !== "analysis" && selected && detailMinimized && (
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
          <dt>期刊</dt>
          <dd>{selected.journal ?? "未知"}</dd>
        </div>
        {(selected.volume || selected.issue || selected.pages) && (
          <div>
            <dt>卷期页</dt>
            <dd>
              {[
                selected.volume ? `卷 ${selected.volume}` : undefined,
                selected.issue ? `期 ${selected.issue}` : undefined,
                selected.pages ? `页 ${selected.pages}` : undefined,
              ]
                .filter(Boolean)
                .join(" · ")}
            </dd>
          </div>
        )}
        {selected.issn && selected.issn.length > 0 && (
          <div>
            <dt>ISSN</dt>
            <dd>{selected.issn.join(" / ")}</dd>
          </div>
        )}
        <div>
          <dt>被引次数</dt>
          <dd>{formatCitedByCount(selected.citedByCount)}</dd>
        </div>
        {selected.depth !== undefined && (
          <div>
            <dt>图谱层级</dt>
            <dd>{formatCitationGraphLayer(selected)}</dd>
          </div>
        )}
        {selected.parentIds && selected.parentIds.length > 0 && (
          <div>
            <dt>关系路径</dt>
            <dd>
              {selected.depth === 2
                ? selected.direction === "references"
                  ? "目标论文 → 一阶参考 → 当前论文"
                  : "目标论文 → 一阶引用 → 当前论文"
                : selected.direction === "references"
                  ? "目标论文 → 当前参考论文"
                  : selected.direction === "citing"
                    ? "当前论文 → 目标论文"
                    : "当前目标论文"}
            </dd>
          </div>
        )}
        {selected.openAlexId && (
          <div>
            <dt>OpenAlex</dt>
            <dd>{selected.openAlexId}</dd>
          </div>
        )}
        {selected.matchStatus && (
          <div>
            <dt>匹配状态</dt>
            <dd>
              <span className={`citation-match-state ${selected.matchStatus}`}>
                {formatMatchStatus(selected.matchStatus)}
              </span>
            </dd>
          </div>
        )}
        {typeof selected.matchConfidence === "number" && (
          <div>
            <dt>匹配置信度</dt>
            <dd>{Math.round(selected.matchConfidence)}%</dd>
          </div>
        )}
        {selected.metadataSources && selected.metadataSources.length > 0 && (
          <div>
            <dt>元数据来源</dt>
            <dd>{formatMetadataSources(selected.metadataSources)}</dd>
          </div>
        )}
        {selected.textQuality === "degraded" && (
          <div>
            <dt>PDF 文本</dt>
            <dd>存在乱码；匹配时未依赖缺失字符</dd>
          </div>
        )}
      </dl>
      {selected.rawCitation && (
        <article className="citation-raw-reference">
          <span>PDF 原始书目</span>
          <p>{selected.rawCitation}</p>
        </article>
      )}
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
    node.direction === "both"
      ? "both"
      : node.kind === "library"
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
      } ${data.dimmed ? "dimmed" : ""} ${
        node.matchStatus ? `match-${node.matchStatus}` : ""
      } ${node.depth === 2 ? "focused-depth-2" : ""}`}
    >
      <Handle type="target" position={Position.Left} />
      <strong title={formatCitationTitle(node.title)}>
        {formatCitationTitle(node.title)}
      </strong>
      <div className="citation-flow-node-meta">
        <span>{node.year ?? "年份未知"}</span>
        <span>被引 {formatCitedByCount(node.citedByCount)}</span>
        <span className="citation-flow-node-author">
          {node.depth !== undefined
            ? formatCitationGraphLayer(node)
            : (node.authors[0] ?? node.journal ?? "作者未知")}
        </span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function formatCitedByCount(value?: number): string {
  return typeof value === "number" ? value.toLocaleString() : "未知";
}

function formatCitationGraphLayer(node: CitationGraphNode): string {
  if (node.depth === 0 || node.direction === "root") return "目标论文";
  if (node.depth === 1 && node.direction === "references") return "一阶参考";
  if (node.depth === 2 && node.direction === "references") return "二阶参考";
  if (node.depth === 1 && node.direction === "citing") return "一阶引用";
  if (node.depth === 2 && node.direction === "citing") return "二阶引用";
  return "双向关联";
}

function formatMatchStatus(status: CitationMatchStatus): string {
  const labels: Record<CitationMatchStatus, string> = {
    verified: "已确认",
    probable: "可能匹配",
    ambiguous: "匹配存疑",
    unresolved: "未解析",
  };
  return labels[status];
}

function formatMetadataSources(sources: CitationMetadataSource[]): string {
  const labels: Record<CitationMetadataSource, string> = {
    library: "文献库",
    pdf: "PDF",
    crossref: "Crossref",
    openalex: "OpenAlex",
    "europe-pmc": "Europe PMC",
    arxiv: "arXiv",
  };
  return [...new Set(sources)].map((source) => labels[source]).join(" / ");
}

function buildFlowGraph(
  citationNodes: CitationGraphNode[],
  citationEdges: CitationGraphSnapshot["edges"],
  query: string,
  focusedNodeIds: ReadonlySet<string> = new Set(),
): { nodes: CitationFlowNode[]; edges: Edge[]; layoutKey: string } {
  if (citationNodes.some((node) => node.depth !== undefined)) {
    return buildFocusedFlowGraph(
      citationNodes,
      citationEdges,
      query,
      focusedNodeIds,
    );
  }
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
            (normalizedQuery && !haystack.includes(normalizedQuery)) ||
            (focusedNodeIds.size > 0 && !focusedNodeIds.has(citation.id)),
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
    // 高亮只改变节点明暗，不改变 dagre 布局。不要把 focusedNodeIds 写入
    // layoutKey，否则从“分析”返回图谱时会误触发 fitView 并重置用户缩放。
    layoutKey: `${citationNodes.map((node) => node.id).join("|")}:${citationEdges
      .map((edge) => edge.id)
      .join("|")}`,
  };
}

function buildFocusedFlowGraph(
  citationNodes: CitationGraphNode[],
  citationEdges: CitationGraphSnapshot["edges"],
  query: string,
  focusedNodeIds: ReadonlySet<string>,
): { nodes: CitationFlowNode[]; edges: Edge[]; layoutKey: string } {
  const columnGap = 88;
  const rowGap = 18;
  const columns = new Map<number, CitationGraphNode[]>();

  const getColumn = (node: CitationGraphNode): number => {
    if (node.depth === 0 || node.direction === "root") return 0;
    if (node.direction === "references") return -(node.depth ?? 1);
    if (node.direction === "citing") return node.depth ?? 1;
    const relation = citationEdges.find(
      (edge) =>
        (edge.source === node.id || edge.target === node.id) && edge.relation,
    )?.relation;
    return relation === "reference" ? -(node.depth ?? 1) : (node.depth ?? 1);
  };

  for (const node of citationNodes) {
    const column = getColumn(node);
    const group = columns.get(column) ?? [];
    group.push(node);
    columns.set(column, group);
  }

  const score = (node: CitationGraphNode): string =>
    `${String(node.year ?? 0).padStart(5, "0")}:${node.title}`;
  for (const group of columns.values()) {
    group.sort((first, second) => score(first).localeCompare(score(second)));
  }

  const positions = new Map<string, { x: number; y: number }>();
  const columnHeights = new Map<number, number>();
  for (const [column, group] of columns) {
    columnHeights.set(
      column,
      Math.max(
        0,
        group.length * nodeHeight + Math.max(0, group.length - 1) * rowGap,
      ),
    );
  }
  const maxHeight = Math.max(...columnHeights.values(), nodeHeight);
  for (const [column, group] of columns) {
    const height = columnHeights.get(column) ?? nodeHeight;
    const startY = (maxHeight - height) / 2;
    const x = column * (nodeWidth + columnGap);
    group.forEach((node, index) => {
      positions.set(node.id, {
        x,
        y: startY + index * (nodeHeight + rowGap),
      });
    });
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const nodeById = new Map(citationNodes.map((node) => [node.id, node]));
  const flowNodes = citationNodes.map((citation) => {
    const position = positions.get(citation.id) ?? { x: 0, y: 0 };
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
      type: "citation" as const,
      position,
      data: {
        citation,
        dimmed: Boolean(
          (normalizedQuery && !haystack.includes(normalizedQuery)) ||
          (focusedNodeIds.size > 0 && !focusedNodeIds.has(citation.id)),
        ),
      },
    };
  });

  const flowEdges = citationEdges.map((edge) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    const color =
      edge.relation === "reference"
        ? "#d19732"
        : edge.relation === "citing"
          ? "#388d87"
          : source?.kind === "library" && target?.kind === "external"
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
      style: {
        stroke: color,
        strokeWidth: edge.depth === 2 ? 1.1 : 1.45,
        strokeDasharray: edge.depth === 2 ? "5 4" : undefined,
      },
    };
  });

  return {
    nodes: flowNodes,
    edges: flowEdges,
    layoutKey: `focused:${citationNodes
      .map((node) => `${node.id}:${node.depth}:${node.direction}`)
      .join("|")}:${citationEdges.map((edge) => edge.id).join("|")}`,
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
    if (edge.relation === "reference") {
      if (edge.target === selected.id) {
        const node = byId.get(edge.source);
        if (node) related.push({ node, relation: "references" });
      } else if (edge.source === selected.id) {
        const node = byId.get(edge.target);
        if (node) related.push({ node, relation: "citedBy" });
      }
      continue;
    }
    if (edge.relation === "citing") {
      if (edge.source === selected.id) {
        const node = byId.get(edge.target);
        if (node) related.push({ node, relation: "citedBy" });
      } else if (edge.target === selected.id) {
        const node = byId.get(edge.source);
        if (node) related.push({ node, relation: "references" });
      }
      continue;
    }
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
