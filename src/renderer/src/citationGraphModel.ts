import type {
  CitationGraphNode,
  CitationGraphSnapshot,
  Paper,
} from "../../shared/contracts";
import { normalizeCitationDoi } from "../../shared/citationGraph";

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

export function formatCitationTitle(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
