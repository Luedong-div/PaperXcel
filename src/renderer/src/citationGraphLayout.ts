import type {
  CitationGraphEdge,
  CitationGraphNode,
} from "../../shared/contracts";

export type CitationNodeTone = "root" | "reference" | "citing" | "both";
export function citationNodeTone(
  node: Pick<
    CitationGraphNode,
    "direction" | "depth" | "kind" | "referencedByLibrary" | "citesLibrary"
  >,
): CitationNodeTone {
  if (
    node.direction === "root" ||
    node.depth === 0 ||
    (node.kind === "library" &&
      node.depth === undefined &&
      !node.referencedByLibrary &&
      !node.citesLibrary)
  )
    return "root";
  if (
    node.direction === "both" ||
    (node.referencedByLibrary && node.citesLibrary)
  )
    return "both";
  return node.direction === "references" || node.referencedByLibrary
    ? "reference"
    : "citing";
}
export const CITATION_NODE_COLORS: Record<CitationNodeTone, string> = {
  root: "#5b60ca",
  reference: "#c58b35",
  citing: "#32988a",
  both: "#9471be",
};
export function citationNodeDiameter(node: CitationGraphNode): number {
  if (citationNodeTone(node) === "root") return 44;
  const count = node.citedByCount ?? 0;
  return count >= 1000 ? 38 : count >= 100 ? 26 : 14;
}
export function citationNodeLabel(
  node: Pick<CitationGraphNode, "authors" | "year">,
): string {
  const author = node.authors[0]?.trim();
  const surname = author?.includes(",")
    ? author.split(",")[0]
    : author?.split(/\s+/).at(-1);
  return `${surname || "未知作者"} ${node.year ?? ""}`.trim();
}
export function citationRelationLabel(node: CitationGraphNode): string {
  const tone = citationNodeTone(node);
  if (tone === "root") return "目标论文";
  const depth = node.depth === 2 ? "二阶" : "一阶";
  return `${depth}${tone === "both" ? "双向关联" : tone === "reference" ? "参考文献" : "后续引用"}`;
}

/** Compact sector seeds; the simulation packs them while retaining citation directions. */
export function layoutCitationGraph(
  nodes: CitationGraphNode[],
  edges: CitationGraphEdge[],
): Map<string, { x: number; y: number }> {
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const ordered = [...nodes].sort(
    (a, b) =>
      (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
      a.id.localeCompare(b.id),
  );
  const roots = ordered.filter((node) => citationNodeTone(node) === "root");
  const positions = new Map<string, { x: number; y: number }>();
  roots.forEach((node, index) => {
    const angle = (index * Math.PI * 2) / roots.length;
    const radius = roots.length <= 1 ? 0 : Math.max(75, roots.length * 18);
    positions.set(node.id, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    });
  });
  let outerRadius = Math.max(85, roots.length * 22);
  for (const depth of [1, 2]) {
    let extent = outerRadius;
    for (const tone of ["reference", "citing", "both"] as const) {
      const group = ordered.filter(
        (node) =>
          citationNodeTone(node) === tone && (node.depth ?? 1) === depth,
      );
      const span = tone === "both" ? 1.1 : Math.PI - 0.6;
      const center =
        tone === "reference" ? Math.PI : tone === "citing" ? 0 : -Math.PI / 2;
      group.forEach((node, index) => {
        const radius = Math.sqrt(outerRadius ** 2 + (2 * index * 2400) / span);
        const fraction =
          group.length <= 3
            ? (index + 0.5) / group.length
            : (0.5 + index * 0.61803398875) % 1;
        const angle = center + span * (fraction - 0.5);
        positions.set(node.id, {
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
        });
        extent = Math.max(extent, radius);
      });
    }
    outerRadius = extent + 55;
  }
  return new Map(
    ordered.map((node) => {
      const center = positions.get(node.id) ?? { x: 0, y: 0 };
      const radius = citationNodeDiameter(node) / 2;
      return [node.id, { x: center.x - radius, y: center.y - radius }];
    }),
  );
}
