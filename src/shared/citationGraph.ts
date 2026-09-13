import type {
  CitationGraphDirection,
  CitationGraphExpansionStats,
  CitationGraphEdge,
  CitationGraphNode,
  CitationGraphSnapshot,
  CitationMatchStatus,
  CitationMetadataSource,
  CitationTextQuality,
  Paper,
} from "./contracts";

export const CITATION_GRAPH_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const CITATION_GRAPH_CITING_LIMIT = 20;
export const CITATION_GRAPH_FOCUSED_EXTERNAL_NODE_MAX = 300;
export const CITATION_GRAPH_FOCUSED_FIRST_ORDER_LIMIT = 20;
// 同向二重的外部节点由“一阶 + 二阶”组成：保留 20 篇一阶节点后，
// 二阶节点必须至少还能补足到 300 篇，否则前端滑块即使调到 300 也只能显示 100 篇。
export const CITATION_GRAPH_FOCUSED_SECOND_ORDER_LIMIT =
  CITATION_GRAPH_FOCUSED_EXTERNAL_NODE_MAX -
  CITATION_GRAPH_FOCUSED_FIRST_ORDER_LIMIT;
// 每个一阶引用节点多取一些二阶引用，避免不同父节点之间重复后不足 300 篇。
export const CITATION_GRAPH_FOCUSED_CITING_PER_PARENT_LIMIT = 20;
export const CITATION_GRAPH_FOCUSED_SECOND_ORDER_CANDIDATE_LIMIT =
  CITATION_GRAPH_FOCUSED_SECOND_ORDER_LIMIT * 2;
export const CITATION_GRAPH_EXTERNAL_NODE_MAX = 100;
export const CITATION_GRAPH_CORE_VERSION = 7;
// 扩展数量策略变更后，强制旧的 20/80 快照重新生成，避免继续复用旧缓存。
export const CITATION_GRAPH_EXPANSION_VERSION = 2;

export interface CitationWorkRecord {
  openAlexId: string;
  doi?: string;
  title: string;
  authors: string[];
  journal?: string;
  year?: number;
  abstract?: string;
  keywords?: string[];
  volume?: string;
  issue?: string;
  pages?: string;
  issn?: string[];
  citedByCount?: number;
  referencedOpenAlexIds: string[];
  sourceUrl?: string;
  metadataSources?: CitationMetadataSource[];
  matchStatus?: CitationMatchStatus;
  matchConfidence?: number;
  rawCitation?: string;
  textQuality?: CitationTextQuality;
}

export interface CitationCoreRecord {
  version?: number;
  paperId: string;
  openAlexId?: string;
  referencedOpenAlexIds: string[];
  citingOpenAlexIds: string[];
  fetchedAt: string;
}

export interface CitationGraphExpansionRecord {
  version?: number;
  paperId: string;
  rootOpenAlexId?: string;
  referenceFirstOrderIds: string[];
  referenceSecondOrderIds: string[];
  referenceSecondOrderParentIds: Record<string, string[]>;
  citingFirstOrderIds: string[];
  citingSecondOrderIds: string[];
  citingSecondOrderParentIds: Record<string, string[]>;
  truncatedReferenceCount: number;
  truncatedCitingCount: number;
  errors?: string[];
  fetchedAt: string;
}

export interface CitationGraphCache {
  works: Record<string, CitationWorkRecord>;
  cores: Record<string, CitationCoreRecord>;
  expansions?: Record<string, CitationGraphExpansionRecord>;
  updatedAt?: string;
}

export function emptyCitationGraphCache(): CitationGraphCache {
  return { works: {}, cores: {}, expansions: {} };
}

export function normalizeCitationDoi(value?: string): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[)\]}>.,;:]+$/g, "")
    .toLowerCase();
  return normalized || undefined;
}

export function normalizeOpenAlexId(value?: string): string | undefined {
  const normalized = value?.trim().split("/").pop()?.toUpperCase();
  return normalized && /^W\d+$/.test(normalized) ? normalized : undefined;
}

export function isCitationRecordFresh(
  record: CitationCoreRecord | undefined,
  now = Date.now(),
): boolean {
  if (!record || record.version !== CITATION_GRAPH_CORE_VERSION) return false;
  const fetchedAt = Date.parse(record.fetchedAt);
  return (
    Number.isFinite(fetchedAt) &&
    now - fetchedAt < CITATION_GRAPH_CACHE_MAX_AGE_MS
  );
}

export function isCitationExpansionFresh(
  record: CitationGraphExpansionRecord | undefined,
  now = Date.now(),
): boolean {
  if (!record || record.version !== CITATION_GRAPH_EXPANSION_VERSION) {
    return false;
  }
  const fetchedAt = Date.parse(record.fetchedAt);
  return (
    Number.isFinite(fetchedAt) &&
    now - fetchedAt < CITATION_GRAPH_CACHE_MAX_AGE_MS
  );
}

export function buildCitationGraphSnapshot(
  papers: Paper[],
  cache: CitationGraphCache,
  errors: string[] = [],
): CitationGraphSnapshot {
  const nodes = new Map<string, CitationGraphNode>();
  const edges = new Map<string, CitationGraphEdge>();
  const libraryByDoi = new Map<string, Paper>();
  const libraryByOpenAlexId = new Map<string, Paper>();
  const externalRelations = new Map<
    string,
    {
      referencedByLibrary: boolean;
      citesLibrary: boolean;
      connections: Set<string>;
    }
  >();

  for (const paper of papers) {
    const doi = normalizeCitationDoi(paper.doi);
    if (doi) libraryByDoi.set(doi, paper);
    const core = cache.cores[paper.id];
    const openAlexId = normalizeOpenAlexId(core?.openAlexId);
    const openAlexWork = openAlexId ? cache.works[openAlexId] : undefined;
    if (openAlexId) libraryByOpenAlexId.set(openAlexId, paper);
    nodes.set(libraryNodeId(paper.id), {
      id: libraryNodeId(paper.id),
      kind: "library",
      paperId: paper.id,
      openAlexId,
      doi,
      title: paper.title,
      authors: [...paper.authors],
      journal: paper.journal,
      year: paper.year,
      // 本地论文同样已经在刷新图谱时解析为 OpenAlex Work。资料库元数据
      // 没有摘要时复用该结果，避免只有外围卡片有摘要、核心卡片反而为空。
      abstract:
        paper.abstract?.trim() || openAlexWork?.abstract?.trim() || undefined,
      citedByCount: openAlexId ? openAlexWork?.citedByCount : undefined,
      referencedByLibrary: false,
      citesLibrary: false,
      sourceUrl: paper.sourceUrl,
      metadataSources: ["library", ...(openAlexWork?.metadataSources ?? [])],
      matchStatus: "verified",
      matchConfidence: 100,
    });
  }

  const addRelation = (
    sourcePaper: Paper,
    workId: string,
    relation: "reference" | "citing",
  ): void => {
    const work = cache.works[workId];
    if (!work) return;
    const matchedPaper =
      libraryByOpenAlexId.get(workId) ??
      (work.doi
        ? libraryByDoi.get(normalizeCitationDoi(work.doi) ?? "")
        : undefined);
    const sourceId =
      relation === "reference"
        ? libraryNodeId(sourcePaper.id)
        : matchedPaper
          ? libraryNodeId(matchedPaper.id)
          : externalNodeId(workId);
    const targetId =
      relation === "reference"
        ? matchedPaper
          ? libraryNodeId(matchedPaper.id)
          : externalNodeId(workId)
        : libraryNodeId(sourcePaper.id);
    if (sourceId === targetId) return;
    const edgeId = `${sourceId}->${targetId}`;
    edges.set(edgeId, { id: edgeId, source: sourceId, target: targetId });
    if (matchedPaper) return;
    const state = externalRelations.get(workId) ?? {
      referencedByLibrary: false,
      citesLibrary: false,
      connections: new Set<string>(),
    };
    if (relation === "reference") state.referencedByLibrary = true;
    else state.citesLibrary = true;
    state.connections.add(sourcePaper.id);
    externalRelations.set(workId, state);
  };

  for (const paper of papers) {
    const core = cache.cores[paper.id];
    if (!core) continue;
    for (const workId of core.referencedOpenAlexIds) {
      addRelation(paper, workId, "reference");
    }
    for (const workId of core.citingOpenAlexIds) {
      addRelation(paper, workId, "citing");
    }
  }

  const selectedExternalIds = [...externalRelations.entries()]
    .sort(([firstId, first], [secondId, second]) => {
      const firstWork = cache.works[firstId];
      const secondWork = cache.works[secondId];
      return (
        second.connections.size - first.connections.size ||
        (secondWork?.citedByCount ?? -1) - (firstWork?.citedByCount ?? -1) ||
        (secondWork?.year ?? 0) - (firstWork?.year ?? 0) ||
        (firstWork?.title ?? "").localeCompare(secondWork?.title ?? "")
      );
    })
    .map(([id]) => id);
  const selectedExternal = new Set(selectedExternalIds);

  for (const workId of selectedExternalIds) {
    const work = cache.works[workId];
    const relation = externalRelations.get(workId);
    if (!work || !relation) continue;
    nodes.set(externalNodeId(workId), {
      id: externalNodeId(workId),
      kind: "external",
      openAlexId: normalizeOpenAlexId(work.openAlexId),
      doi: normalizeCitationDoi(work.doi),
      title: work.title,
      authors: [...work.authors],
      journal: work.journal,
      year: work.year,
      abstract: work.abstract,
      keywords: work.keywords ? [...work.keywords] : undefined,
      volume: work.volume,
      issue: work.issue,
      pages: work.pages,
      issn: work.issn ? [...work.issn] : undefined,
      citedByCount: work.citedByCount,
      referencedByLibrary: relation.referencedByLibrary,
      citesLibrary: relation.citesLibrary,
      sourceUrl: work.sourceUrl,
      metadataSources: work.metadataSources
        ? [...work.metadataSources]
        : undefined,
      matchStatus: work.matchStatus,
      matchConfidence: work.matchConfidence,
      rawCitation: work.rawCitation,
      textQuality: work.textQuality,
    });
  }

  for (const [id, edge] of edges) {
    const sourceExternal = edge.source.startsWith("external:");
    const targetExternal = edge.target.startsWith("external:");
    if (
      (sourceExternal &&
        !selectedExternal.has(edge.source.slice("external:".length))) ||
      (targetExternal &&
        !selectedExternal.has(edge.target.slice("external:".length)))
    ) {
      edges.delete(id);
    }
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    updatedAt: cache.updatedAt,
    errors: [...errors],
  };
}

/**
 * 为单篇本地论文构建“二阶参考/二阶引用”专用快照。
 *
 * 这里故意不复用多篇论文的直接关系过滤：二重图谱需要保留
 * 二阶节点之间的链路，数据方向为：
 *
 * 二阶参考 <- 一阶参考 <- 目标论文 <- 一阶引用 <- 二阶引用
 * 数据边始终由引用者指向被引文献；画布箭头反向展示文献的传承关系。
 */
export function buildFocusedCitationGraphSnapshot(
  paper: Paper,
  cache: CitationGraphCache,
  expansion: CitationGraphExpansionRecord,
  errors: string[] = [],
): CitationGraphSnapshot {
  const core = cache.cores[paper.id];
  const rootWorkId = normalizeOpenAlexId(
    expansion.rootOpenAlexId ?? core?.openAlexId,
  );
  const rootWork = rootWorkId ? cache.works[rootWorkId] : undefined;
  const nodes = new Map<string, CitationGraphNode>();
  const edges = new Map<string, CitationGraphEdge>();
  const localByDoi = new Map<string, Paper>();
  const localByOpenAlexId = new Map<string, Paper>();

  // 允许二阶图中的条目显示为“资料库论文”，但只把当前论文作为 root。
  const libraryPapers = [paper];
  for (const localPaper of libraryPapers) {
    const doi = normalizeCitationDoi(localPaper.doi);
    if (doi) localByDoi.set(doi, localPaper);
  }
  if (rootWorkId) localByOpenAlexId.set(rootWorkId, paper);

  const addNode = (
    workId: string,
    direction: Exclude<CitationGraphDirection, "root">,
    depth: 1 | 2,
    parentIds: string[],
  ): string | undefined => {
    const work = cache.works[workId];
    if (!work) return undefined;
    const matchedPaper =
      localByOpenAlexId.get(workId) ??
      (work.doi
        ? localByDoi.get(normalizeCitationDoi(work.doi) ?? "")
        : undefined);
    const nodeId = matchedPaper
      ? libraryNodeId(matchedPaper.id)
      : externalNodeId(workId);
    const existing = nodes.get(nodeId);
    if (existing?.direction === "root") return nodeId;
    const nextDirection =
      direction === "both" ||
      existing?.direction === "both" ||
      (existing?.direction && existing.direction !== direction)
        ? "both"
        : direction;
    const nextParentIds = [
      ...new Set([...(existing?.parentIds ?? []), ...parentIds]),
    ];
    nodes.set(nodeId, {
      id: nodeId,
      kind: matchedPaper ? "library" : "external",
      paperId: matchedPaper?.id,
      openAlexId: normalizeOpenAlexId(work.openAlexId),
      doi: normalizeCitationDoi(work.doi),
      title: matchedPaper?.title ?? work.title,
      authors: [...(matchedPaper?.authors ?? work.authors)],
      journal: matchedPaper?.journal ?? work.journal,
      year: matchedPaper?.year ?? work.year,
      abstract: matchedPaper?.abstract?.trim() || work.abstract,
      keywords: work.keywords ? [...work.keywords] : undefined,
      volume: work.volume,
      issue: work.issue,
      pages: work.pages,
      issn: work.issn ? [...work.issn] : undefined,
      citedByCount: work.citedByCount,
      referencedByLibrary:
        (existing?.referencedByLibrary ?? false) || direction === "references",
      citesLibrary: (existing?.citesLibrary ?? false) || direction === "citing",
      depth: Math.min(existing?.depth ?? depth, depth) as 1 | 2,
      direction: nextDirection,
      parentIds: nextParentIds,
      sourceUrl: matchedPaper?.sourceUrl ?? work.sourceUrl,
      metadataSources: work.metadataSources
        ? [...work.metadataSources]
        : undefined,
      matchStatus: work.matchStatus,
      matchConfidence: work.matchConfidence,
      rawCitation: work.rawCitation,
      textQuality: work.textQuality,
    });
    return nodeId;
  };

  const rootId = libraryNodeId(paper.id);
  nodes.set(rootId, {
    id: rootId,
    kind: "library",
    paperId: paper.id,
    openAlexId: rootWorkId,
    doi: normalizeCitationDoi(paper.doi),
    title: paper.title,
    authors: [...paper.authors],
    journal: paper.journal,
    year: paper.year,
    abstract: paper.abstract?.trim() || rootWork?.abstract,
    citedByCount: rootWork?.citedByCount,
    referencedByLibrary: false,
    citesLibrary: false,
    depth: 0,
    direction: "root",
    parentIds: [],
    sourceUrl: paper.sourceUrl,
    metadataSources: ["library", ...(rootWork?.metadataSources ?? [])],
    matchStatus: "verified",
    matchConfidence: 100,
  });

  const addEdge = (
    source: string | undefined,
    target: string | undefined,
    relation: "reference" | "citing",
    depth: 1 | 2,
  ): void => {
    if (!source || !target || source === target) return;
    const id = `${source}->${target}:${relation}`;
    edges.set(id, {
      id,
      source,
      target,
      relation,
      depth,
    });
  };

  const referenceFirstNodes = new Map<string, string>();
  const citingFirstNodes = new Map<string, string>();
  for (const workId of expansion.referenceFirstOrderIds) {
    const firstId = addNode(workId, "references", 1, [rootId]);
    if (firstId && firstId !== rootId) referenceFirstNodes.set(workId, firstId);
    addEdge(rootId, firstId, "reference", 1);
  }
  for (const workId of expansion.citingFirstOrderIds) {
    const firstId = addNode(workId, "citing", 1, [rootId]);
    if (firstId && firstId !== rootId) citingFirstNodes.set(workId, firstId);
    addEdge(firstId, rootId, "citing", 1);
  }
  for (const workId of expansion.referenceSecondOrderIds) {
    const parentNodeIds = (
      expansion.referenceSecondOrderParentIds[workId] ?? []
    )
      .map((parentId) => referenceFirstNodes.get(parentId))
      .filter((id): id is string => Boolean(id));
    if (!parentNodeIds.length) continue;
    const secondId = addNode(workId, "references", 2, parentNodeIds);
    for (const parentNodeId of parentNodeIds) {
      addEdge(parentNodeId, secondId, "reference", 2);
    }
  }
  for (const workId of expansion.citingSecondOrderIds) {
    const parentNodeIds = (expansion.citingSecondOrderParentIds[workId] ?? [])
      .map((parentId) => citingFirstNodes.get(parentId))
      .filter((id): id is string => Boolean(id));
    if (!parentNodeIds.length) continue;
    const secondId = addNode(workId, "citing", 2, parentNodeIds);
    for (const parentNodeId of parentNodeIds) {
      addEdge(secondId, parentNodeId, "citing", 2);
    }
  }

  const expansionStats: CitationGraphExpansionStats = {
    referenceFirstOrderCount: expansion.referenceFirstOrderIds.length,
    referenceSecondOrderCount: expansion.referenceSecondOrderIds.length,
    citingFirstOrderCount: expansion.citingFirstOrderIds.length,
    citingSecondOrderCount: expansion.citingSecondOrderIds.length,
    truncatedReferenceCount: expansion.truncatedReferenceCount,
    truncatedCitingCount: expansion.truncatedCitingCount,
  };
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    updatedAt: cache.updatedAt,
    errors: [...(errors.length ? errors : (expansion.errors ?? []))],
    graphMode: "focused-two-hop",
    focusedPaperId: paper.id,
    expansion: expansionStats,
  };
}

/**
 * 按被引次数截取外部节点；二阶文献与它的一阶路径共同占用显示名额。
 * 这里是“显示上限”，不改缓存和原始关系，
 * 因此用户拖动滑块只会改变画布/分析范围，不会触发重新抓取。
 */
export function limitCitationGraphExternalNodes(
  snapshot: CitationGraphSnapshot,
  limits: { references: number; citing: number },
  max = CITATION_GRAPH_EXTERNAL_NODE_MAX,
): CitationGraphSnapshot {
  const referenceLimit = clampExternalNodeLimit(limits.references, max);
  const citingLimit = clampExternalNodeLimit(limits.citing, max);
  if (snapshot.graphMode === "focused-two-hop") {
    const visibleIds = new Set([
      ...snapshot.nodes
        .filter((node) => node.depth === 0 || node.direction === "root")
        .map((node) => node.id),
      ...selectConnectedCitationNodes(snapshot, "reference", referenceLimit),
      ...selectConnectedCitationNodes(snapshot, "citing", citingLimit),
    ]);
    return {
      ...snapshot,
      nodes: snapshot.nodes.filter((node) => visibleIds.has(node.id)),
      edges: snapshot.edges.filter(
        (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
      ),
    };
  }
  const referenceIds = rankExternalNodes(
    snapshot.nodes.filter((node) => isReferenceExternalNode(node)),
  )
    .slice(0, referenceLimit)
    .map((node) => node.id);
  const citingIds = rankExternalNodes(
    snapshot.nodes.filter((node) => isCitingExternalNode(node)),
  )
    .slice(0, citingLimit)
    .map((node) => node.id);
  const visibleIds = new Set([
    ...snapshot.nodes
      .filter((node) => node.kind === "library")
      .map((node) => node.id),
    ...referenceIds,
    ...citingIds,
  ]);
  return {
    ...snapshot,
    nodes: snapshot.nodes.filter((node) => visibleIds.has(node.id)),
    edges: snapshot.edges.filter(
      (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
    ),
  };
}

function selectConnectedCitationNodes(
  snapshot: CitationGraphSnapshot,
  relation: "reference" | "citing",
  limit: number,
): Set<string> {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const rootIds = new Set(
    snapshot.nodes
      .filter((node) => node.depth === 0 || node.direction === "root")
      .map((node) => node.id),
  );
  const belongsToSide = (node: CitationGraphNode): boolean =>
    relation === "reference"
      ? node.referencedByLibrary ||
        node.direction === "references" ||
        node.direction === "both"
      : node.citesLibrary ||
        node.direction === "citing" ||
        node.direction === "both";
  const children = new Map<string, Set<string>>();
  const directIds = new Set<string>();
  for (const edge of snapshot.edges) {
    if (edge.relation !== relation) continue;
    const parent = relation === "reference" ? edge.source : edge.target;
    const child = relation === "reference" ? edge.target : edge.source;
    if (!byId.has(parent) || !byId.has(child)) continue;
    if (rootIds.has(parent)) directIds.add(child);
    const parents = children.get(child) ?? new Set<string>();
    parents.add(parent);
    children.set(child, parents);
  }
  const validFirstIds = new Set(
    snapshot.nodes
      .filter(
        (node) =>
          node.depth === 1 &&
          belongsToSide(node) &&
          (!rootIds.size || directIds.has(node.id)),
      )
      .map((node) => node.id),
  );
  const candidates = rankExternalNodes(
    snapshot.nodes.filter(
      (node) =>
        belongsToSide(node) && (node.depth === 2 || validFirstIds.has(node.id)),
    ),
  );
  const selected = new Set(
    candidates
      .filter((node) => node.kind === "library" && validFirstIds.has(node.id))
      .map((node) => node.id),
  );
  let externalCount = 0;
  // A second pass can add a local second-order paper after its external parent was selected.
  for (let pass = 0; pass < 2; pass++)
    for (const node of candidates) {
      if (selected.has(node.id)) continue;
      let path = [node];
      if (node.depth === 2) {
        const parents = rankExternalNodes(
          [...(children.get(node.id) ?? [])]
            .filter((id) => validFirstIds.has(id))
            .map((id) => byId.get(id)!),
        );
        const parent =
          parents.find((candidate) => selected.has(candidate.id)) ??
          parents.find((candidate) => candidate.kind === "library") ??
          parents[0];
        if (!parent) continue;
        path = [parent, node];
      }
      const extra = path.filter(
        (candidate) =>
          candidate.kind === "external" && !selected.has(candidate.id),
      ).length;
      if (externalCount + extra > limit) continue;
      for (const candidate of path) selected.add(candidate.id);
      externalCount += extra;
    }
  return selected;
}

function isReferenceExternalNode(node: CitationGraphNode): boolean {
  return (
    node.kind === "external" &&
    (node.direction === "references" ||
      node.direction === "both" ||
      node.referencedByLibrary)
  );
}

function isCitingExternalNode(node: CitationGraphNode): boolean {
  return (
    node.kind === "external" &&
    (node.direction === "citing" ||
      node.direction === "both" ||
      node.citesLibrary)
  );
}

function rankExternalNodes(nodes: CitationGraphNode[]): CitationGraphNode[] {
  return [...nodes].sort(
    (first, second) =>
      (second.citedByCount ?? -1) - (first.citedByCount ?? -1) ||
      (second.year ?? 0) - (first.year ?? 0) ||
      first.title.localeCompare(second.title) ||
      first.id.localeCompare(second.id),
  );
}

function clampExternalNodeLimit(value: number, max: number): number {
  return Math.max(0, Math.min(Math.max(0, Math.round(max)), Math.round(value)));
}

function libraryNodeId(paperId: string): string {
  return `paper:${paperId}`;
}

function externalNodeId(openAlexId: string): string {
  return `external:${openAlexId}`;
}
