import {
  buildCitationNetworkAnalysis,
  type BuildCitationNetworkAnalysisInput,
} from "../shared/citationAnalysis";
import {
  buildFocusedCitationGraphSnapshot,
  buildCitationGraphSnapshot,
  CITATION_GRAPH_FOCUSED_EXTERNAL_NODE_MAX,
  limitCitationGraphExternalNodes,
  type CitationGraphCache,
} from "../shared/citationGraph";
import type {
  CitationGraphAnalysisOptions,
  CitationNetworkAnalysis,
  Paper,
} from "../shared/contracts";

export function analyzeCitationNetwork(
  papers: Paper[],
  cache: CitationGraphCache,
  now = new Date(),
  options: CitationGraphAnalysisOptions = {},
): CitationNetworkAnalysis {
  const baseSnapshot =
    options.mode === "focused-two-hop"
      ? buildFocusedSnapshotForAnalysis(papers, cache)
      : buildCitationGraphSnapshot(papers, cache);
  const externalNodeMax =
    options.mode === "focused-two-hop"
      ? CITATION_GRAPH_FOCUSED_EXTERNAL_NODE_MAX
      : undefined;
  const snapshot = options.externalLimits
    ? limitCitationGraphExternalNodes(
        baseSnapshot,
        options.externalLimits,
        externalNodeMax,
      )
    : baseSnapshot;
  const referencesByNodeId: BuildCitationNetworkAnalysisInput["referencesByNodeId"] =
    {};

  for (const node of snapshot.nodes) {
    if (node.paperId) {
      referencesByNodeId[node.id] = [
        ...(cache.cores[node.paperId]?.referencedOpenAlexIds ?? []),
      ];
      continue;
    }
    referencesByNodeId[node.id] = node.openAlexId
      ? [...(cache.works[node.openAlexId]?.referencedOpenAlexIds ?? [])]
      : [];
  }

  const analysis = buildCitationNetworkAnalysis({
    snapshot,
    referencesByNodeId,
    generatedAt: now,
  });
  return {
    ...analysis,
    graphMode: snapshot.graphMode,
    focusedPaperId: snapshot.focusedPaperId,
  };
}

function buildFocusedSnapshotForAnalysis(
  papers: Paper[],
  cache: CitationGraphCache,
) {
  if (papers.length !== 1) {
    throw new Error("同向二重图谱的分析需要选择一篇目标论文。");
  }
  const paper = papers[0];
  const expansion = cache.expansions?.[paper.id];
  if (!expansion) {
    throw new Error("请先生成这篇论文的同向二重图谱，再进入分析。");
  }
  return buildFocusedCitationGraphSnapshot(paper, cache, expansion);
}
