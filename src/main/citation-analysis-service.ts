import {
  buildCitationNetworkAnalysis,
  type BuildCitationNetworkAnalysisInput,
} from "../shared/citationAnalysis";
import {
  buildCitationGraphSnapshot,
  type CitationGraphCache,
} from "../shared/citationGraph";
import type { CitationNetworkAnalysis, Paper } from "../shared/contracts";

export function analyzeCitationNetwork(
  papers: Paper[],
  cache: CitationGraphCache,
  now = new Date(),
): CitationNetworkAnalysis {
  const snapshot = buildCitationGraphSnapshot(papers, cache);
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

  return buildCitationNetworkAnalysis({
    snapshot,
    referencesByNodeId,
    generatedAt: now,
  });
}
