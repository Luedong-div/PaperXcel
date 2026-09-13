import type {
  CitationGraphEdge,
  CitationGraphExpansionStats,
  CitationGraphNode,
} from "../../shared/contracts";

export interface CitationGraphExportLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CitationGraphExportNode extends Omit<
  CitationGraphNode,
  "abstract"
> {
  abstract: string | null;
  layout: CitationGraphExportLayout;
  dimmed: boolean;
}

export interface CitationGraphExportFilters {
  selectedPaperIds: string[];
  selectedScopeLabel: string;
  yearRange?: [number, number];
  query: string;
  showLocal: boolean;
  showExternal: boolean;
  showReferences: boolean;
  showCiting: boolean;
}

export interface CitationGraphExportDocument {
  schemaVersion: 1;
  exportedAt: string;
  title: string;
  subtitle: string;
  sourceUpdatedAt?: string;
  filters: CitationGraphExportFilters;
  stats: {
    nodeCount: number;
    edgeCount: number;
  };
  graphMode?: "standard" | "focused-two-hop";
  focusedPaperId?: string;
  expansion?: CitationGraphExpansionStats;
  nodes: CitationGraphExportNode[];
  edges: CitationGraphEdge[];
  errors: string[];
}

interface CitationGraphExportInputNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  citation: CitationGraphNode;
  dimmed: boolean;
}

interface CitationGraphExportDocumentOptions {
  exportedAt: string;
  title: string;
  subtitle: string;
  sourceUpdatedAt?: string;
  graphMode?: "standard" | "focused-two-hop";
  focusedPaperId?: string;
  expansion?: CitationGraphExpansionStats;
  filters: CitationGraphExportFilters;
  nodes: CitationGraphExportInputNode[];
  edges: CitationGraphEdge[];
  errors: string[];
}

export function buildCitationGraphExportDocument({
  exportedAt,
  title,
  subtitle,
  sourceUpdatedAt,
  filters,
  nodes,
  edges,
  errors,
  graphMode,
  focusedPaperId,
  expansion,
}: CitationGraphExportDocumentOptions): CitationGraphExportDocument {
  return {
    schemaVersion: 1,
    exportedAt,
    title,
    subtitle,
    sourceUpdatedAt,
    graphMode,
    focusedPaperId,
    expansion,
    filters: {
      ...filters,
      selectedPaperIds: [...filters.selectedPaperIds],
      yearRange: filters.yearRange ? [...filters.yearRange] : undefined,
    },
    stats: { nodeCount: nodes.length, edgeCount: edges.length },
    nodes: nodes.map(({ citation, x, y, width, height, dimmed }) => ({
      ...citation,
      authors: [...citation.authors],
      abstract: citation.abstract ?? null,
      metadataSources: citation.metadataSources
        ? [...citation.metadataSources]
        : undefined,
      issn: citation.issn ? [...citation.issn] : undefined,
      parentIds: citation.parentIds ? [...citation.parentIds] : undefined,
      layout: { x, y, width, height },
      dimmed,
    })),
    edges: edges.map((edge) => ({ ...edge })),
    errors: [...errors],
  };
}

export function serializeCitationGraphExportDocument(
  document: CitationGraphExportDocument,
): string {
  return JSON.stringify(document, null, 2);
}
