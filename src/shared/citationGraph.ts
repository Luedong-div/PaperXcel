import type {
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
export const CITATION_GRAPH_CORE_VERSION = 7;

export interface CitationWorkRecord {
  openAlexId: string;
  doi?: string;
  title: string;
  authors: string[];
  journal?: string;
  year?: number;
  abstract?: string;
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

export interface CitationGraphCache {
  works: Record<string, CitationWorkRecord>;
  cores: Record<string, CitationCoreRecord>;
  updatedAt?: string;
}

export function emptyCitationGraphCache(): CitationGraphCache {
  return { works: {}, cores: {} };
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
      abstract: paper.abstract,
      citedByCount: openAlexId
        ? cache.works[openAlexId]?.citedByCount
        : undefined,
      referencedByLibrary: false,
      citesLibrary: false,
      sourceUrl: paper.sourceUrl,
      metadataSources: [
        "library",
        ...(openAlexId ? (cache.works[openAlexId]?.metadataSources ?? []) : []),
      ],
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

function libraryNodeId(paperId: string): string {
  return `paper:${paperId}`;
}

function externalNodeId(openAlexId: string): string {
  return `external:${openAlexId}`;
}
