import {
  scopeCitationSnapshot,
  markLibraryNodes,
  formatCitationTitle,
} from "./citationGraphModel";
import {
  nodeTypes,
  edgeTypes,
  buildFlowGraph,
  type CitationFlowNode,
  type CitationNodeData,
} from "./CitationGraphElements";
import {
  DetailOverview,
  DetailTabButton,
  DetailTextState,
  formatCitedByCount,
} from "./CitationGraphDetails";
import { CitationPaperSelector } from "./CitationPaperSelector";
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
import {
  CITATION_NODE_COLORS,
  citationNodeDiameter,
  citationNodeTone,
  citationRelationLabel,
  layoutCitationGraph,
} from "./citationGraphLayout";
import {
  Background,
  type NodeChange,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./citationWorkspace.css";
import { useCitationGraphPhysics } from "./useCitationGraphPhysics";
import {
  ArrowRightFromLine,
  ArrowRightToLine,
  BookOpen,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  ChartNetwork,
  Compass,
  Database,
  Download,
  ExternalLink,
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
  Square,
  X,
} from "lucide-react";
import type {
  CitationDiscoveryMode,
  CitationDiscoveryFilters,
  CitationDiscoveryInput,
  CitationDiscoveryResult,
  CitationGraphNode,
  CitationGraphSnapshot,
  ModelReasoningEffort,
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
  CITATION_DISCOVERY_PURE_SEARCH_DEFAULT_CANDIDATES,
  CITATION_DISCOVERY_PURE_SEARCH_MAX_CANDIDATES,
} from "../../shared/citationDiscovery";
import { CitationAnalysisPanel } from "./CitationAnalysisPanel";
import { useCitationAnalysis } from "./useCitationAnalysis";
import { useResearchConversation } from "./useResearchConversation";
import { ResearchConversationBar } from "./ResearchConversationBar";
import { DiscoveryAgentPanel } from "./DiscoveryAgentPanel";
import { CitationDiscoveryPanel } from "./CitationDiscoveryPanel";
import { CitationReferencesPanel } from "./CitationReferencesPanel";
import {
  buildCitationGraphExportDocument,
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
  onError: (message: string) => void;
  analysisModel?: string;
  reasoningEffort?: ModelReasoningEffort;
}
type DetailTab = "details" | "abstract" | "references";
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
  onError,
  analysisModel,
  reasoningEffort,
}: CitationGraphWorkspaceProps): React.JSX.Element {
  const { fitView, getViewport, setViewport } = useReactFlow();
  const [snapshot, setSnapshot] = useState<CitationGraphSnapshot>({
    nodes: [],
    edges: [],
    errors: [],
  });
  const [viewMode, setViewMode] = useState<CitationWorkspaceView>("graph");
  const [graphDepth, setGraphDepth] = useState<1 | 2>(1);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [expandingTwoHop, setExpandingTwoHop] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searching, setDiscovering] = useState(false);
  const [historicalSnapshot, setHistoricalSnapshot] =
    useState<CitationGraphSnapshot>();
  const [analysisRunSnapshot, setAnalysisRunSnapshot] =
    useState<CitationGraphSnapshot>();
  const discoveryAgent = useResearchConversation("discovery");
  const discovering = searching || discoveryAgent.running;
  const [analysisQuestion, setAnalysisQuestion] = useState("");
  const [discoveryQuery, setDiscoveryQuery] = useState("");
  const [discoveryFilters, setDiscoveryFilters] =
    useState<CitationDiscoveryFilters>({
      sort: "relevance",
      sources: ["openalex", "crossref", "europe-pmc"],
    });
  const discoveryRequestRef = useRef<
    | {
        id: string;
        scope: string;
        mode: CitationDiscoveryMode;
        sequence: number;
      }
    | undefined
  >(undefined);
  const [lastDiscoveryInput, setLastDiscoveryInput] =
    useState<CitationDiscoveryInput>();

  const [discoveryMode, setDiscoveryMode] =
    useState<CitationDiscoveryMode>("contextual");
  const [searchResult, setDiscoveryResult] =
    useState<CitationDiscoveryResult>();
  const discoveryResult =
    discoveryMode === "contextual"
      ? discoveryAgent.state.discovery?.result
      : searchResult;
  const [pureSearchLimit, setPureSearchLimit] = useState(
    CITATION_DISCOVERY_PURE_SEARCH_DEFAULT_CANDIDATES,
  );
  const [analysisFocusIds, setAnalysisFocusIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [exporting, setExporting] = useState(false);
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
      references: 36,
      citing: 36,
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
  const [hoveredNode, setHoveredNode] = useState<{
    node: CitationGraphNode;
    x: number;
    y: number;
  }>();
  const [selectedId, setSelectedId] = useState<string>();
  const [referenceDetail, setReferenceDetail] = useState<CitationGraphNode>();
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
  const fittedLayoutKeyRef = useRef<string | undefined>(undefined);
  const initialFitKeyRef = useRef<string | undefined>(undefined);
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
  const analysisAgent = useCitationAnalysis();
  const analysis = analysisAgent.state;
  const analyzing = analysisAgent.running;
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

  const regroupGraph = (): void => {
    setHistoricalSnapshot(undefined);
    savedGraphViewportRef.current = undefined;
    setLayoutRevision((current) => current + 1);
  };

  const refresh = async (force = false): Promise<void> => {
    if (refreshing) return;
    regroupGraph();
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

  const expandFocusedTwoHop = async (force = false): Promise<void> => {
    if (expandingTwoHop || selectedPaperIdList.length !== 1) {
      if (selectedPaperIdList.length !== 1) {
        onError("同向二重图谱需要先选择一篇论文。");
      }
      return;
    }
    regroupGraph();
    setExpandingTwoHop(true);
    try {
      const result = await window.paperxcel.citationGraph.expand(
        selectedPaperIdList[0],
        force,
      );
      if (selectionScopeRef.current !== selectionScopeKey) return;
      setSnapshot(result.snapshot);
      setGraphDepth(2);
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
    setAnalysisFocusIds(new Set());
    void loadSnapshot();
  };

  useEffect(() => {
    const unsubscribe = window.paperxcel.citationGraph.onDiscoveryProgress?.(
      (progress) => {
        const active = discoveryRequestRef.current;
        if (
          !active ||
          active.id !== progress.requestId ||
          progress.sequence <= active.sequence
        )
          return;
        if (
          active.mode !== "pure-search" &&
          active.scope !== selectionScopeRef.current
        )
          return;
        active.sequence = progress.sequence;
        setDiscoveryResult(progress.result);
      },
    );
    return () => {
      unsubscribe?.();
      if (discoveryRequestRef.current)
        void window.paperxcel.citationGraph.cancelDiscovery(
          discoveryRequestRef.current.id,
        );
    };
  }, []);

  const stopDiscovery = (): void => {
    if (discoveryAgent.running) {
      discoveryAgent.stop();
      return;
    }
    const active = discoveryRequestRef.current;
    if (active)
      void window.paperxcel.citationGraph
        .cancelDiscovery(active.id)
        .catch((error) => onError(String(error)));
  };
  const discover = async (
    mode: CitationDiscoveryMode = discoveryMode,
    requestedLimit = CITATION_DISCOVERY_PURE_SEARCH_DEFAULT_CANDIDATES,
    cursor?: string,
  ): Promise<void> => {
    if (discovering || discoveryAgent.managing) return;
    if (mode === "pure-search" && !discoveryQuery.trim()) {
      onError("请输入研究问题、论文标题或 DOI。");
      return;
    }
    if (mode === "contextual" && !selectedPaperIdList.length) {
      onError("请先选择推荐起点。");
      return;
    }
    if (discoveryFilters.sources?.length === 0) {
      onError("请至少选择一个搜索来源。");
      return;
    }
    if (
      discoveryFilters.yearFrom &&
      discoveryFilters.yearTo &&
      discoveryFilters.yearFrom > discoveryFilters.yearTo
    ) {
      onError("起始年份不能晚于结束年份。");
      return;
    }
    setDiscoveryMode(mode);
    if (mode === "contextual") {
      setLastDiscoveryInput({
        query: discoveryQuery.trim(),
        filters: discoveryFilters,
      });
      await discoveryAgent.start({
        paperIds: selectedPaperIdList,
        question: discoveryQuery,
        filters: discoveryFilters,
        reasoningEffort,
      });
      return;
    }
    const id = crypto.randomUUID();
    discoveryRequestRef.current = {
      id,
      scope: selectionScopeKey,
      mode,
      sequence: 0,
    };
    const input: CitationDiscoveryInput = {
      requestId: id,
      cursor,
      paperIds: [],
      query: discoveryQuery.trim(),
      limit: Math.min(
        CITATION_DISCOVERY_PURE_SEARCH_MAX_CANDIDATES,
        requestedLimit,
      ),
      mode,
      filters: discoveryFilters,
    };
    setLastDiscoveryInput(input);
    setDiscovering(true);
    setPureSearchLimit(input.limit!);
    if (!cursor) {
      setDiscoveryResult(undefined);
      setSelectedId(undefined);
    }
    try {
      const result = await window.paperxcel.citationGraph.discover(input);
      if (discoveryRequestRef.current?.id === id) setDiscoveryResult(result);
    } catch (error) {
      if (discoveryRequestRef.current?.id === id)
        onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (discoveryRequestRef.current?.id === id) {
        discoveryRequestRef.current = undefined;
        setDiscovering(false);
      }
    }
  };
  const discoveryFiltersDirty = Boolean(
    lastDiscoveryInput &&
    (lastDiscoveryInput.query !== discoveryQuery.trim() ||
      JSON.stringify(lastDiscoveryInput.filters) !==
        JSON.stringify(discoveryFilters)),
  );
  const loadMorePureSearch = (amount: 50 | 100): void => {
    if (discovering || discoveryFiltersDirty) return;
    void discover(
      discoveryMode,
      pureSearchLimit + amount,
      discoveryResult?.cursor,
    );
  };

  const updateSelectedPaperIds = (next: Set<string>): void => {
    setHistoricalSnapshot(undefined);
    selectionScopeRef.current = papers
      .filter((paper) => next.has(paper.id))
      .map((paper) => paper.id)
      .join("\u0000");
    if (discoveryRequestRef.current?.mode === "contextual") stopDiscovery();
    setSelectedPaperIds(next);
    setGraphDepth(1);
    setSnapshot({ nodes: [], edges: [], errors: [] });
    setDiscoveryResult(undefined);
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

  const currentScopedSnapshot = useMemo(
    () =>
      markLibraryNodes(
        snapshot.graphMode === "focused-two-hop"
          ? snapshot
          : scopeCitationSnapshot(snapshot, selectedPaperIds),
        papers,
      ),
    [papers, selectedPaperIds, snapshot],
  );

  const scopedSnapshot = historicalSnapshot ?? currentScopedSnapshot;

  const runAnalysis = (question: string, scopeTurnId?: string): void => {
    if (
      analyzing ||
      analysisAgent.managing ||
      analysisAgent.loadingHistory ||
      (!scopeTurnId && (loading || !selectedPaperIdList.length))
    )
      return;
    setAnalysisRunSnapshot(
      scopeTurnId ? analysisAgent.turn?.scope.snapshot : currentScopedSnapshot,
    );
    void analysisAgent.start({
      paperIds: selectedPaperIdList,
      mode: graphDepth === 2 ? "focused-two-hop" : "standard",
      question,
      scopeTurnId,
      reasoningEffort,
    });
  };
  const analyze = (): void => runAnalysis(analysisQuestion);

  useEffect(() => {
    if (
      selectedId &&
      referenceDetail?.id !== selectedId &&
      !scopedSnapshot.nodes.some((node) => node.id === selectedId) &&
      !discoveryResult?.candidates.some(
        (candidate) => candidate.work.id === selectedId,
      )
    ) {
      setSelectedId(undefined);
      setDetailMinimized(false);
    }
  }, [discoveryResult, scopedSnapshot.nodes, selectedId, referenceDetail]);

  const selected =
    scopedSnapshot.nodes.find((node) => node.id === selectedId) ??
    discoveryResult?.candidates.find(
      (candidate) => candidate.work.id === selectedId,
    )?.work ??
    (referenceDetail?.id === selectedId ? referenceDetail : undefined);
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
  }, [selectedId]);

  useEffect(() => {
    const keepPanelInViewport = (): void => {
      setDetailPosition((current) => clampDetailPanelPosition(current));
    };
    window.addEventListener("resize", keepPanelInViewport);
    return () => window.removeEventListener("resize", keepPanelInViewport);
  }, []);

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
    // Circle limits affect the drawing; AI analysis reads the complete corpus.
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
    const limited = limitCitationGraphExternalNodes(
      filteredSnapshot,
      activeExternalNodeLimits,
      externalNodeMax,
    );
    if (!analysisFocusIds.size) return limited;
    const retained = new Set([
      ...limited.nodes.map((node) => node.id),
      ...analysisFocusIds,
    ]);
    // Findings can cite papers outside the circle limit. Include their real parents too.
    const byId = new Map(filteredSnapshot.nodes.map((node) => [node.id, node]));
    for (const id of retained)
      for (const parent of byId.get(id)?.parentIds ?? []) retained.add(parent);
    return {
      ...filteredSnapshot,
      nodes: filteredSnapshot.nodes.filter((node) => retained.has(node.id)),
      edges: filteredSnapshot.edges.filter(
        (edge) => retained.has(edge.source) && retained.has(edge.target),
      ),
    };
  }, [
    analysisFocusIds,
    activeExternalNodeLimits,
    externalNodeMax,
    selectedYearRange,
    showCiting,
    showExternal,
    showLocal,
    showReferences,
    scopedSnapshot,
  ]);

  const analysisSnapshot =
    analysisAgent.turn?.scope.snapshot ??
    analysisRunSnapshot ??
    currentScopedSnapshot;

  const graphLayout = useMemo(
    () => layoutCitationGraph(visibleSnapshot.nodes, visibleSnapshot.edges),
    [visibleSnapshot.nodes, visibleSnapshot.edges],
  );
  const positionScope = `${selectionScopeKey}:${graphDepth}:${layoutRevision}`;
  const physics = useCitationGraphPhysics(
    visibleSnapshot.nodes,
    visibleSnapshot.edges,
    graphLayout,
    positionScope,
    viewMode === "graph" && !loading,
  );
  const flow = useMemo(
    () =>
      buildFlowGraph(
        visibleSnapshot.nodes,
        visibleSnapshot.edges,
        query,
        analysisFocusIds,
        graphLayout,
      ),
    [
      analysisFocusIds,
      query,
      visibleSnapshot.edges,
      visibleSnapshot.nodes,
      graphLayout,
    ],
  );
  const layoutViewKey = `${positionScope}:${flow.layoutKey}`;

  const renderedNodes = useMemo(
    () =>
      flow.nodes.map((node) => ({
        ...node,
        position: physics.positions.get(node.id) ?? node.position,
        selected: node.id === selectedId,
        data: {
          ...node.data,
          highlighted:
            analysisFocusIds.has(node.id) || node.id === hoveredNode?.node.id,
        },
      })),
    [
      flow.nodes,
      physics.positions,
      selectedId,
      analysisFocusIds,
      hoveredNode?.node.id,
    ],
  );
  const hoveredNeighbors = useMemo(() => {
    if (!hoveredNode) return new Set<string>();
    return new Set(
      visibleSnapshot.edges
        .filter(
          (edge) =>
            edge.source === hoveredNode.node.id ||
            edge.target === hoveredNode.node.id,
        )
        .map((edge) => edge.id),
    );
  }, [hoveredNode, visibleSnapshot.edges]);
  const renderedEdges = useMemo(
    () =>
      flow.edges.map((edge) => ({
        ...edge,
        style: {
          ...edge.style,
          opacity: hoveredNode
            ? hoveredNeighbors.has(edge.id)
              ? 1
              : 0.12
            : edge.style?.opacity,
          strokeWidth: hoveredNeighbors.has(edge.id)
            ? 2
            : edge.style?.strokeWidth,
        },
        zIndex: hoveredNeighbors.has(edge.id) ? 2 : 0,
      })),
    [flow.edges, hoveredNode, hoveredNeighbors],
  );
  const handleNodesChange = (changes: NodeChange<CitationFlowNode>[]): void => {
    for (const change of changes)
      if (change.type === "position" && change.position) {
        if (change.dragging) fittedLayoutKeyRef.current = layoutViewKey;
        physics.move(change.id, change.position);
        if (change.dragging !== true) physics.release(change.id);
      }
  };

  useLayoutEffect(() => {
    if (viewMode !== "graph") return;
    const saved = savedGraphViewportRef.current;
    if (!saved || saved.layoutKey !== layoutViewKey) return;
    fittedLayoutKeyRef.current = layoutViewKey;
    const frame = window.requestAnimationFrame(() => {
      void setViewport(saved.viewport, { duration: 0 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [layoutViewKey, setViewport, viewMode]);

  useEffect(() => {
    if (
      viewMode !== "graph" ||
      loading ||
      !flow.nodes.length ||
      fittedLayoutKeyRef.current === layoutViewKey ||
      (!physics.settled && initialFitKeyRef.current === layoutViewKey)
    ) {
      return;
    }
    let secondFrame: number | undefined;
    const fit = (): void => {
      if (fittedLayoutKeyRef.current === layoutViewKey) return;
      initialFitKeyRef.current = layoutViewKey;
      if (physics.settled) fittedLayoutKeyRef.current = layoutViewKey;
      void fitView({
        padding: 0.16,
        maxZoom: 1.8,
        duration: physics.settled ? 240 : 0,
      });
    };
    const frame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(fit);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (secondFrame !== undefined) {
        window.cancelAnimationFrame(secondFrame);
      }
    };
  }, [
    fitView,
    layoutViewKey,
    flow.nodes.length,
    viewMode,
    loading,
    physics.settled,
  ]);

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

  const exportGraph = async (): Promise<void> => {
    if (exporting || !flow.nodes.length) return;
    setExporting(true);
    try {
      const exportedAt = new Date();
      const selectedScopeLabel =
        "已选 " + selectedPaperIdList.length + " 篇本地论文";
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
        nodes: renderedNodes.map((node) => ({
          id: node.id,
          x: node.position.x,
          y: node.position.y,
          width: citationNodeDiameter(node.data.citation),
          height: citationNodeDiameter(node.data.citation),
          citation: node.data.citation,
          dimmed: node.data.dimmed,
        })),
        edges: visibleSnapshot.edges,
        errors: snapshot.errors,
      });
      await window.paperxcel.citationGraph.export({
        format: "json",
        content: serializeCitationGraphExportDocument(document),
      });
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(false);
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
    setActiveTab("details");
    setReferenceDetail(undefined);
    setSelectedId(nodeId);
    setDetailMinimized(false);
  };

  const openReferenceDetails = (node: CitationGraphNode): void => {
    setActiveTab("details");
    setReferenceDetail(node);
    setSelectedId(node.id);
    setDetailMinimized(false);
  };

  const closeDetails = (): void => {
    setReferenceDetail(undefined);
    setSelectedId(undefined);
    setDetailMinimized(false);
  };

  const changeViewMode = (nextViewMode: CitationWorkspaceView): void => {
    if (viewMode === "graph" && nextViewMode !== "graph") {
      savedGraphViewportRef.current = {
        layoutKey: layoutViewKey,
        viewport: getViewport(),
      };
    }
    setViewMode(nextViewMode);
  };

  const focusGraphNodes = (nodeIds: string[]): void => {
    setHistoricalSnapshot(analysisSnapshot);
    setAnalysisFocusIds(new Set(nodeIds));
    setShowLocal(true);
    setShowExternal(true);
    setShowReferences(true);
    setShowCiting(true);
    setSelectedYearRange(undefined);
    changeViewMode("graph");
  };

  const selectAnalysisNode = (nodeId: string): void => {
    setActiveTab("details");
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

  return (
    <section className="citation-browser">
      <header className="citation-browser-bar citation-graph-toolbar">
        <div className="citation-browser-heading">
          <span className="citation-browser-heading-icon">
            <Network size={18} />
          </span>
          <div>
            <h2>引文图谱</h2>
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
                      ? "研究问题、论文标题或 DOI"
                      : "输入主题关键词，可留空使用选中文献"
                }
                aria-label={
                  viewMode === "graph" ? "搜索引文图谱" : "外部论文发现关键词"
                }
                onChange={(event) => {
                  if (viewMode === "graph") setQuery(event.target.value);
                  else {
                    setDiscoveryQuery(event.target.value);
                    setPureSearchLimit(
                      CITATION_DISCOVERY_PURE_SEARCH_DEFAULT_CANDIDATES,
                    );
                  }
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
            <div className="citation-graph-export">
              <button
                className="citation-browser-export-trigger"
                type="button"
                title="导出当前图谱"
                disabled={Boolean(exporting) || flow.nodes.length === 0}
                onClick={() => void exportGraph()}
              >
                {exporting ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <Download size={15} />
                )}
                导出 JSON
              </button>
            </div>
          )}
          <button
            className="citation-browser-refresh"
            type="button"
            disabled={
              (selectedPaperIdList.length === 0 &&
                !(viewMode === "analysis" && analyzing)) ||
              (viewMode === "graph"
                ? refreshing || expandingTwoHop
                : viewMode === "discovery"
                  ? discovering || discoveryAgent.managing
                  : analysisAgent.managing ||
                    analysis.status === "stopping" ||
                    (!analyzing && (loading || analysisAgent.loadingHistory)))
            }
            onClick={() => {
              if (viewMode === "graph") {
                if (graphDepth === 2) void expandFocusedTwoHop(true);
                else void refresh(false);
              } else if (viewMode === "discovery") void discover("contextual");
              else if (analyzing) analysisAgent.stop();
              else analyze();
            }}
          >
            {viewMode === "analysis" && analyzing ? (
              <Square size={14} />
            ) : (viewMode === "graph" && (refreshing || expandingTwoHop)) ||
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
                : analyzing
                  ? "停止分析"
                  : analysis.status === "idle"
                    ? "开始 AI 分析"
                    : "重新分析"}
          </button>
          {viewMode === "discovery" && (
            <button
              className="citation-browser-pure-search"
              type="button"
              disabled={
                discovering || discoveryAgent.managing || !discoveryQuery.trim()
              }
              title="搜索研究问题、标题或 DOI"
              onClick={() => void discover("pure-search")}
            >
              <Search size={15} />
              论文搜索
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
                  <CitationPaperSelector
                    papers={papers}
                    folders={folders}
                    selectedPaperIds={selectedPaperIds}
                    onTogglePaper={togglePaper}
                    onToggleGroup={toggleFolder}
                  />
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
                  <ArrowRightToLine size={14} />
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
                  <ArrowRightFromLine size={14} />
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
              <p>AI 全局研究</p>
              <section className="citation-filter-section citation-research-sidebar">
                <span className="citation-filter-label">分析结果</span>
                <div>
                  <ChartNetwork size={14} />
                  <span>研究主题</span>
                  <small>
                    {analysis.research?.findings.filter(
                      (item) => item.kind === "theme",
                    ).length ?? 0}
                  </small>
                </div>
                <div>
                  <Link2 size={14} />
                  <span>已读文献</span>
                  <small>{analysis.research?.coverage.read ?? 0}</small>
                </div>
                <div>
                  <Network size={14} />
                  <span>演进路径</span>
                  <small>
                    {analysis.research?.findings.filter(
                      (item) => item.kind === "path",
                    ).length ?? 0}
                  </small>
                </div>
              </section>
            </>
          )}

          <div className="citation-filter-footer">
            <Database size={14} />
            OpenAlex / Crossref / Europe PMC
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
                {historicalSnapshot && (
                  <button
                    type="button"
                    className="citation-ai-focus"
                    onClick={() => {
                      setHistoricalSnapshot(undefined);
                      setAnalysisFocusIds(new Set());
                    }}
                  >
                    正在查看本轮分析图谱 · 返回当前范围
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
                  data-layout-settled={physics.settled}
                  nodes={renderedNodes}
                  edges={renderedEdges}
                  edgeTypes={edgeTypes}
                  onNodesChange={handleNodesChange}
                  onNodeMouseEnter={(event, node) =>
                    setHoveredNode({
                      node: node.data.citation,
                      x: event.clientX,
                      y: event.clientY,
                    })
                  }
                  onNodeMouseMove={(event, node) =>
                    setHoveredNode({
                      node: node.data.citation,
                      x: event.clientX,
                      y: event.clientY,
                    })
                  }
                  onNodeMouseLeave={() => setHoveredNode(undefined)}
                  onNodeDragStart={(_event, node) => {
                    setHoveredNode(undefined);
                    physics.move(node.id, node.position);
                  }}
                  onNodeDragStop={(_event, node) => physics.release(node.id)}
                  onMoveStart={(event) => {
                    setHoveredNode(undefined);
                    if (event) fittedLayoutKeyRef.current = layoutViewKey;
                  }}
                  nodeTypes={nodeTypes}
                  minZoom={0.08}
                  maxZoom={3}
                  nodesDraggable
                  nodesConnectable={false}
                  elementsSelectable
                  onMoveEnd={(_event, viewport) => {
                    savedGraphViewportRef.current = {
                      layoutKey: layoutViewKey,
                      viewport,
                    };
                  }}
                  onNodeClick={(_event, node) => {
                    setHoveredNode(undefined);
                    openDetails(node.id);
                  }}
                  onPaneClick={closeDetails}
                >
                  <Background color="#dfe5e3" gap={26} size={1} />
                  <Controls
                    showInteractive={false}
                    onZoomIn={() => {
                      fittedLayoutKeyRef.current = layoutViewKey;
                    }}
                    onZoomOut={() => {
                      fittedLayoutKeyRef.current = layoutViewKey;
                    }}
                    onFitView={() => {
                      fittedLayoutKeyRef.current = layoutViewKey;
                    }}
                  />
                  <MiniMap
                    className="citation-graph-minimap"
                    nodeColor={(node) =>
                      CITATION_NODE_COLORS[
                        citationNodeTone(
                          (node.data as CitationNodeData).citation,
                        )
                      ]
                    }
                    maskColor="rgba(233, 239, 237, 0.68)"
                  />
                </ReactFlow>
              )}

              {hoveredNode && (
                <div
                  className="citation-node-tooltip"
                  role="tooltip"
                  style={{
                    left: Math.max(
                      12,
                      Math.min(hoveredNode.x + 18, window.innerWidth - 372),
                    ),
                    top: Math.max(
                      12,
                      Math.min(hoveredNode.y + 18, window.innerHeight - 224),
                    ),
                  }}
                >
                  <span
                    className={`citation-tooltip-relation ${citationNodeTone(hoveredNode.node)}`}
                  >
                    {citationRelationLabel(hoveredNode.node)}
                  </span>
                  <strong>{formatCitationTitle(hoveredNode.node.title)}</strong>
                  <p>
                    {hoveredNode.node.authors.slice(0, 4).join(", ") ||
                      "作者未知"}
                  </p>
                  <small>
                    {hoveredNode.node.year ?? "年份未知"} ·{" "}
                    {hoveredNode.node.journal ?? "来源未知"} · 被引{" "}
                    {formatCitedByCount(hoveredNode.node.citedByCount)}
                  </small>
                  <footer>点击查看摘要和参考文件 · 拖拽调整位置</footer>
                </div>
              )}
              <div className="citation-canvas-key" aria-label="图例">
                <span>
                  <i className="local" />
                  目标论文
                </span>
                <span>
                  <i className="reference" />
                  参考文献
                </span>
                <span>
                  <i className="citing" />
                  后续引用
                </span>
                <span>
                  <i className="both" />
                  双向关联
                </span>
                <span>
                  <i className="edge-solid" />
                  一阶
                </span>
                <span>
                  <i className="edge-dashed" />
                  二阶
                </span>
                <span className="citation-key-note">
                  箭头：被引用文献 → 引用它的论文
                </span>
              </div>
            </>
          ) : viewMode === "discovery" ? (
            <CitationDiscoveryPanel
              result={discoveryResult}
              agentPanel={
                discoveryMode === "contextual" ? (
                  <DiscoveryAgentPanel
                    state={discoveryAgent.state}
                    onSelect={(work) => {
                      setReferenceDetail(work);
                      openDetails(work.id);
                    }}
                    controls={
                      <ResearchConversationBar
                        key={discoveryAgent.conversation?.id ?? "new-discovery"}
                        conversation={discoveryAgent.conversation}
                        sessions={discoveryAgent.sessions}
                        turn={discoveryAgent.turn}
                        running={discoveryAgent.running}
                        loading={discoveryAgent.loadingHistory}
                        managing={discoveryAgent.managing}
                        onOpen={(id) => void discoveryAgent.open(id)}
                        onNew={() => {
                          discoveryAgent.newConversation();
                          setDiscoveryQuery("");
                        }}
                        onTurn={discoveryAgent.selectTurn}
                        onRename={discoveryAgent.rename}
                        onDelete={async () => {
                          await discoveryAgent.deleteConversation();
                          setDiscoveryQuery("");
                          closeDetails();
                        }}
                        onDeleteTurn={async (turnId) => {
                          await discoveryAgent.deleteTurn(turnId);
                          closeDetails();
                        }}
                      />
                    }
                  />
                ) : undefined
              }
              mode={discoveryMode}
              loading={discovering}
              selectedPaperCount={selectedPaperIdList.length}
              onOpenDetails={(work) => {
                setReferenceDetail(work);
                openDetails(work.id);
              }}
              onOpenSource={(sourceUrl) => window.open(sourceUrl, "_blank")}
              onLoadMore={
                discoveryMode === "pure-search" ? loadMorePureSearch : undefined
              }
              resultLimit={pureSearchLimit}
              maxResultLimit={
                discoveryMode === "pure-search"
                  ? CITATION_DISCOVERY_PURE_SEARCH_MAX_CANDIDATES
                  : CITATION_DISCOVERY_MAX_CANDIDATES
              }
              filters={discoveryFilters}
              onFiltersChange={setDiscoveryFilters}
              filtersDirty={discoveryFiltersDirty}
              onApplyFilters={() => void discover()}
              onStop={stopDiscovery}
              onAddToLibrary={async (work) => {
                if (!work.doi) return;
                await window.paperxcel.papers.addFromIdentifier(work.doi);
              }}
              libraryDois={
                new Set(
                  papers
                    .map((paper) => normalizeCitationDoi(paper.doi))
                    .filter((doi): doi is string => Boolean(doi)),
                )
              }
            />
          ) : (
            <div className="citation-analysis-workspace">
              <CitationAnalysisPanel
                state={analysis}
                snapshot={analysisSnapshot}
                model={analysisModel}
                question={analysisQuestion}
                onQuestionChange={setAnalysisQuestion}
                onStart={analyze}
                selectedPaperCount={selectedPaperIdList.length}
                conversationControls={
                  <ResearchConversationBar
                    key={analysisAgent.conversation?.id ?? "new-analysis"}
                    conversation={analysisAgent.conversation}
                    sessions={analysisAgent.sessions}
                    turn={analysisAgent.turn}
                    running={analyzing}
                    loading={analysisAgent.loadingHistory}
                    managing={analysisAgent.managing}
                    onOpen={(id) => void analysisAgent.open(id)}
                    onNew={() => {
                      analysisAgent.newConversation();
                      setAnalysisQuestion("");
                      setAnalysisRunSnapshot(undefined);
                    }}
                    onTurn={analysisAgent.selectTurn}
                    onRename={analysisAgent.rename}
                    onDelete={async () => {
                      await analysisAgent.deleteConversation();
                      setAnalysisQuestion("");
                      setAnalysisRunSnapshot(undefined);
                    }}
                    onDeleteTurn={async (turnId) => {
                      await analysisAgent.deleteTurn(turnId);
                      setAnalysisRunSnapshot(undefined);
                    }}
                    followUp={{
                      currentPaperCount: selectedPaperIdList.length,
                      canFollowUp: Boolean(analysisQuestion.trim()),
                      onFollowUp: () =>
                        runAnalysis(analysisQuestion, analysisAgent.turn?.id),
                      onReapply: () =>
                        runAnalysis(
                          analysisAgent.turn?.question ?? analysisQuestion,
                        ),
                    }}
                  />
                }
                onFocusNodes={focusGraphNodes}
                onSelectNode={selectAnalysisNode}
              />
            </div>
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
              active={activeTab === "references"}
              label="参考文件"
              onClick={() => setActiveTab("references")}
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
            {activeTab === "references" && (
              <CitationReferencesPanel
                key={selected.id}
                selected={selected}
                onSelect={openReferenceDetails}
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
