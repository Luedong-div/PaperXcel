import type {
  CitationGraphNode,
  CitationGraphSnapshot,
  CitationNetworkAnalysis,
  CitationNetworkBridge,
  CitationNetworkCommunity,
  CitationNetworkPath,
  CitationNetworkSimilarity,
} from "./contracts";
import { normalizeOpenAlexId } from "./citationGraph";
import { tokenizeResearchText } from "./citationDiscovery";

export interface BuildCitationNetworkAnalysisInput {
  snapshot: CitationGraphSnapshot;
  referencesByNodeId: Record<string, string[]>;
  generatedAt?: Date;
}

interface WeightedLink {
  source: string;
  target: string;
  weight: number;
}

export function buildCitationNetworkAnalysis({
  snapshot,
  referencesByNodeId,
  generatedAt = new Date(),
}: BuildCitationNetworkAnalysisInput): CitationNetworkAnalysis {
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const openAlexToNode = new Map(
    snapshot.nodes
      .map((node) => [normalizeOpenAlexId(node.openAlexId), node.id] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[0])),
  );
  const normalizedReferences = new Map(
    snapshot.nodes.map((node) => [
      node.id,
      new Set(
        (referencesByNodeId[node.id] ?? [])
          .map(normalizeOpenAlexId)
          .filter((id): id is string => Boolean(id)),
      ),
    ]),
  );
  const bibliographicCoupling = buildBibliographicCoupling(
    snapshot.nodes,
    normalizedReferences,
  );
  const coCitation = buildCoCitation(
    snapshot.nodes,
    normalizedReferences,
    openAlexToNode,
    nodeById,
  );
  const similarityLinks: WeightedLink[] = [
    ...snapshot.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      weight: 0.35,
    })),
    ...bibliographicCoupling.map((link) => ({
      source: link.source,
      target: link.target,
      weight: 0.45 + link.score * 2.2,
    })),
    ...coCitation.map((link) => ({
      source: link.source,
      target: link.target,
      weight: 0.35 + link.score * 1.8,
    })),
  ];
  const communityGroups = detectCommunities(snapshot.nodes, similarityLinks);
  const communities = describeCommunities(communityGroups, nodeById);
  const communityByNode = new Map<string, string>();
  for (const community of communities) {
    for (const nodeId of community.nodeIds) {
      communityByNode.set(nodeId, community.id);
    }
  }
  const adjacency = buildUndirectedAdjacency(
    snapshot.nodes.map((node) => node.id),
    similarityLinks,
  );

  return {
    generatedAt: generatedAt.toISOString(),
    metrics: {
      nodeCount: snapshot.nodes.length,
      edgeCount: snapshot.edges.length,
      density: calculateDensity(snapshot.nodes.length, snapshot.edges.length),
      componentCount: countComponents(
        snapshot.nodes.map((node) => node.id),
        snapshot.edges,
      ),
      communityCount: communities.length,
    },
    communities,
    bibliographicCoupling: bibliographicCoupling.slice(0, 60),
    coCitation: coCitation.slice(0, 60),
    keyPaths: buildKeyPaths(snapshot, nodeById),
    bridges: buildBridgeNodes(snapshot.nodes, adjacency, communityByNode).slice(
      0,
      20,
    ),
  };
}

function buildBibliographicCoupling(
  nodes: CitationGraphNode[],
  references: Map<string, Set<string>>,
): CitationNetworkSimilarity[] {
  const results: CitationNetworkSimilarity[] = [];
  const eligible = nodes.filter(
    (node) => (references.get(node.id)?.size ?? 0) > 0,
  );
  for (let firstIndex = 0; firstIndex < eligible.length; firstIndex += 1) {
    const first = eligible[firstIndex];
    const firstReferences = references.get(first.id)!;
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < eligible.length;
      secondIndex += 1
    ) {
      const second = eligible[secondIndex];
      const secondReferences = references.get(second.id)!;
      const sharedCount = intersectionSize(firstReferences, secondReferences);
      if (sharedCount === 0) continue;
      const score =
        sharedCount / Math.sqrt(firstReferences.size * secondReferences.size);
      results.push({
        source: first.id,
        target: second.id,
        score: roundScore(score),
        sharedCount,
      });
    }
  }
  return sortSimilarity(results);
}

function buildCoCitation(
  nodes: CitationGraphNode[],
  references: Map<string, Set<string>>,
  openAlexToNode: Map<string, string>,
  nodeById: Map<string, CitationGraphNode>,
): CitationNetworkSimilarity[] {
  const pairCounts = new Map<string, number>();
  const citedBySources = new Map<string, Set<string>>();

  for (const [sourceId, sourceReferences] of references) {
    const citedNodes = unique(
      [...sourceReferences]
        .map((referenceId) => openAlexToNode.get(referenceId))
        .filter((nodeId): nodeId is string => Boolean(nodeId))
        .sort(
          (firstId, secondId) =>
            (nodeById.get(secondId)?.citedByCount ?? 0) -
              (nodeById.get(firstId)?.citedByCount ?? 0) ||
            firstId.localeCompare(secondId),
        )
        .slice(0, 100),
    );
    for (const citedNodeId of citedNodes) {
      const sources = citedBySources.get(citedNodeId) ?? new Set<string>();
      sources.add(sourceId);
      citedBySources.set(citedNodeId, sources);
    }
    for (let firstIndex = 0; firstIndex < citedNodes.length; firstIndex += 1) {
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < citedNodes.length;
        secondIndex += 1
      ) {
        const key = pairKey(citedNodes[firstIndex], citedNodes[secondIndex]);
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  return sortSimilarity(
    [...pairCounts.entries()]
      .map(([key, sharedCount]) => {
        const [source, target] = splitPairKey(key);
        if (!nodeIds.has(source) || !nodeIds.has(target)) return undefined;
        const sourceCount = citedBySources.get(source)?.size ?? 1;
        const targetCount = citedBySources.get(target)?.size ?? 1;
        return {
          source,
          target,
          score: roundScore(sharedCount / Math.sqrt(sourceCount * targetCount)),
          sharedCount,
        } satisfies CitationNetworkSimilarity;
      })
      .filter((link): link is CitationNetworkSimilarity => Boolean(link)),
  );
}

function detectCommunities(
  nodes: CitationGraphNode[],
  links: WeightedLink[],
): string[][] {
  const nodeIds = nodes.map((node) => node.id).sort();
  const adjacency = buildWeightedAdjacency(nodeIds, links);
  const labels = new Map(nodeIds.map((nodeId) => [nodeId, nodeId]));
  const ordered = [...nodeIds].sort(
    (first, second) =>
      (adjacency.get(second)?.size ?? 0) - (adjacency.get(first)?.size ?? 0) ||
      first.localeCompare(second),
  );

  for (let iteration = 0; iteration < 30; iteration += 1) {
    let changed = false;
    for (const nodeId of ordered) {
      const neighbors = adjacency.get(nodeId);
      if (!neighbors?.size) continue;
      const scores = new Map<string, number>();
      for (const [neighborId, weight] of neighbors) {
        const label = labels.get(neighborId)!;
        scores.set(label, (scores.get(label) ?? 0) + weight);
      }
      const current = labels.get(nodeId)!;
      const currentScore = scores.get(current) ?? 0;
      const best = [...scores.entries()].sort(
        ([firstLabel, firstScore], [secondLabel, secondScore]) =>
          secondScore - firstScore ||
          (firstLabel === current ? -1 : secondLabel === current ? 1 : 0) ||
          firstLabel.localeCompare(secondLabel),
      )[0];
      if (best && best[0] !== current && best[1] > currentScore + 1e-8) {
        labels.set(nodeId, best[0]);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const grouped = new Map<string, string[]>();
  for (const nodeId of nodeIds) {
    const label = labels.get(nodeId)!;
    const group = grouped.get(label) ?? [];
    group.push(nodeId);
    grouped.set(label, group);
  }
  return [...grouped.values()].sort(
    (first, second) =>
      second.length - first.length || first[0].localeCompare(second[0]),
  );
}

function describeCommunities(
  groups: string[][],
  nodeById: Map<string, CitationGraphNode>,
): CitationNetworkCommunity[] {
  return groups.map((nodeIds, index) => {
    const nodes = nodeIds
      .map((nodeId) => nodeById.get(nodeId))
      .filter((node): node is CitationGraphNode => Boolean(node));
    const topTerms = topCommunityTerms(nodes, 5);
    const years = nodes
      .map((node) => node.year)
      .filter((year): year is number => typeof year === "number");
    return {
      id: `community-${index + 1}`,
      label: topTerms.slice(0, 3).join(" / ") || `研究群落 ${index + 1}`,
      nodeIds: [...nodeIds],
      size: nodeIds.length,
      libraryCount: nodes.filter((node) => node.kind === "library").length,
      externalCount: nodes.filter((node) => node.kind === "external").length,
      topTerms,
      startYear: years.length ? Math.min(...years) : undefined,
      endYear: years.length ? Math.max(...years) : undefined,
      citedByCount: nodes.reduce(
        (total, node) => total + (node.citedByCount ?? 0),
        0,
      ),
    };
  });
}

function buildKeyPaths(
  snapshot: CitationGraphSnapshot,
  nodeById: Map<string, CitationGraphNode>,
): CitationNetworkPath[] {
  const predecessors = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    const newer = nodeById.get(edge.source);
    const older = nodeById.get(edge.target);
    if (!newer?.year || !older?.year || older.year >= newer.year) {
      continue;
    }
    const list = predecessors.get(newer.id) ?? [];
    list.push(older.id);
    predecessors.set(newer.id, list);
  }
  const ordered = [...snapshot.nodes].sort(
    (first, second) =>
      (first.year ?? Number.MAX_SAFE_INTEGER) -
        (second.year ?? Number.MAX_SAFE_INTEGER) ||
      first.id.localeCompare(second.id),
  );
  const bestPath = new Map<string, string[]>();
  for (const node of ordered) {
    let best = [node.id];
    for (const predecessor of predecessors.get(node.id) ?? []) {
      const candidate = [
        ...(bestPath.get(predecessor) ?? [predecessor]),
        node.id,
      ];
      if (
        candidate.length > best.length ||
        (candidate.length === best.length &&
          pathImpact(candidate, nodeById) > pathImpact(best, nodeById))
      ) {
        best = candidate;
      }
    }
    bestPath.set(node.id, best);
  }

  const selected: CitationNetworkPath[] = [];
  for (const nodeIds of [...bestPath.values()].sort(
    (first, second) =>
      second.length - first.length ||
      pathImpact(second, nodeById) - pathImpact(first, nodeById),
  )) {
    if (nodeIds.length < 2) continue;
    if (
      selected.some(
        (path) =>
          path.nodeIds[0] === nodeIds[0] &&
          path.nodeIds.at(-1) === nodeIds.at(-1),
      )
    ) {
      continue;
    }
    const years = nodeIds
      .map((nodeId) => nodeById.get(nodeId)?.year)
      .filter((year): year is number => typeof year === "number");
    selected.push({
      id: `path-${selected.length + 1}`,
      nodeIds,
      score: Math.round(nodeIds.length * 10 + pathImpact(nodeIds, nodeById)),
      startYear: years.length ? Math.min(...years) : undefined,
      endYear: years.length ? Math.max(...years) : undefined,
    });
    if (selected.length >= 8) break;
  }
  return selected;
}

function buildBridgeNodes(
  nodes: CitationGraphNode[],
  adjacency: Map<string, Set<string>>,
  communityByNode: Map<string, string>,
): CitationNetworkBridge[] {
  const maxDegree = Math.max(
    1,
    ...nodes.map((node) => adjacency.get(node.id)?.size ?? 0),
  );
  return nodes
    .map((node) => {
      const neighbors = adjacency.get(node.id) ?? new Set<string>();
      const connectedCommunities = new Set(
        [...neighbors]
          .map((neighborId) => communityByNode.get(neighborId))
          .filter((id): id is string => Boolean(id)),
      ).size;
      const ownCommunity = communityByNode.get(node.id);
      const crossCommunityEdges = [...neighbors].filter(
        (neighborId) =>
          communityByNode.get(neighborId) &&
          communityByNode.get(neighborId) !== ownCommunity,
      ).length;
      return {
        nodeId: node.id,
        degree: neighbors.size,
        connectedCommunities,
        score: Math.round(
          connectedCommunities * 24 +
            crossCommunityEdges * 8 +
            (neighbors.size / maxDegree) * 20,
        ),
      };
    })
    .filter((bridge) => bridge.degree > 1)
    .sort(
      (first, second) =>
        second.score - first.score ||
        second.degree - first.degree ||
        first.nodeId.localeCompare(second.nodeId),
    );
}

function buildWeightedAdjacency(
  nodeIds: string[],
  links: WeightedLink[],
): Map<string, Map<string, number>> {
  const adjacency = new Map(
    nodeIds.map((nodeId) => [nodeId, new Map<string, number>()]),
  );
  for (const link of links) {
    if (link.source === link.target) continue;
    const source = adjacency.get(link.source);
    const target = adjacency.get(link.target);
    if (!source || !target) continue;
    source.set(link.target, (source.get(link.target) ?? 0) + link.weight);
    target.set(link.source, (target.get(link.source) ?? 0) + link.weight);
  }
  return adjacency;
}

function buildUndirectedAdjacency(
  nodeIds: string[],
  links: WeightedLink[],
): Map<string, Set<string>> {
  const adjacency = new Map(
    nodeIds.map((nodeId) => [nodeId, new Set<string>()]),
  );
  for (const link of links) {
    adjacency.get(link.source)?.add(link.target);
    adjacency.get(link.target)?.add(link.source);
  }
  return adjacency;
}

function countComponents(
  nodeIds: string[],
  edges: CitationGraphSnapshot["edges"],
): number {
  if (nodeIds.length === 0) return 0;
  const adjacency = new Map(
    nodeIds.map((nodeId) => [nodeId, new Set<string>()]),
  );
  for (const edge of edges) {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }
  const visited = new Set<string>();
  let components = 0;
  for (const nodeId of nodeIds) {
    if (visited.has(nodeId)) continue;
    components += 1;
    const pending = [nodeId];
    visited.add(nodeId);
    while (pending.length) {
      const current = pending.pop()!;
      for (const neighbor of adjacency.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        pending.push(neighbor);
      }
    }
  }
  return components;
}

function topCommunityTerms(
  nodes: CitationGraphNode[],
  limit: number,
): string[] {
  const scores = new Map<string, number>();
  for (const node of nodes) {
    for (const token of tokenizeResearchText(node.title)) {
      scores.set(token, (scores.get(token) ?? 0) + 3);
    }
    for (const token of tokenizeResearchText(node.abstract ?? "")) {
      scores.set(token, (scores.get(token) ?? 0) + 1);
    }
  }
  return [...scores.entries()]
    .sort(
      ([firstTerm, firstScore], [secondTerm, secondScore]) =>
        secondScore - firstScore ||
        secondTerm.length - firstTerm.length ||
        firstTerm.localeCompare(secondTerm),
    )
    .slice(0, limit)
    .map(([term]) => term);
}

function sortSimilarity(
  links: CitationNetworkSimilarity[],
): CitationNetworkSimilarity[] {
  return links.sort(
    (first, second) =>
      second.score - first.score ||
      second.sharedCount - first.sharedCount ||
      first.source.localeCompare(second.source) ||
      first.target.localeCompare(second.target),
  );
}

function calculateDensity(nodeCount: number, edgeCount: number): number {
  if (nodeCount < 2) return 0;
  return roundScore(edgeCount / (nodeCount * (nodeCount - 1)));
}

function pathImpact(
  nodeIds: string[],
  nodeById: Map<string, CitationGraphNode>,
): number {
  return nodeIds.reduce(
    (total, nodeId) =>
      total + Math.log1p(nodeById.get(nodeId)?.citedByCount ?? 0),
    0,
  );
}

function intersectionSize<T>(first: Set<T>, second: Set<T>): number {
  let count = 0;
  const [small, large] =
    first.size <= second.size ? [first, second] : [second, first];
  for (const value of small) {
    if (large.has(value)) count += 1;
  }
  return count;
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function pairKey(first: string, second: string): string {
  return first.localeCompare(second) <= 0
    ? `${first}\u0000${second}`
    : `${second}\u0000${first}`;
}

function splitPairKey(key: string): [string, string] {
  const [first, second] = key.split("\u0000");
  return [first, second];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
