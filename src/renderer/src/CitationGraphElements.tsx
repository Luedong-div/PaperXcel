import {
  BaseEdge,
  Handle,
  MarkerType,
  Position,
  useInternalNode,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type {
  CitationGraphNode,
  CitationGraphSnapshot,
} from "../../shared/contracts";
import {
  CITATION_NODE_COLORS,
  citationNodeDiameter,
  citationNodeLabel,
  citationNodeTone,
  citationRelationLabel,
} from "./citationGraphLayout";

export interface CitationNodeData extends Record<string, unknown> {
  citation: CitationGraphNode;
  dimmed: boolean;
}

export type CitationFlowNode = Node<CitationNodeData, "citation">;

export const nodeTypes = { citation: CitationNode };

export const edgeTypes = { citation: CitationEdge };

function CitationNode({
  data,
  selected,
}: NodeProps<CitationFlowNode>): React.JSX.Element {
  const node = data.citation;
  const diameter = citationNodeDiameter(node);
  return (
    <div
      className={`citation-dot-node ${citationNodeTone(node)} ${selected ? "selected" : ""} ${data.dimmed ? "dimmed" : ""} ${data.highlighted ? "highlighted" : ""} ${node.depth === 2 ? "depth-two" : ""} ${node.kind === "library" ? "in-library" : ""}`}
      style={{ width: diameter, height: diameter }}
      aria-label={`${node.title} · ${citationRelationLabel(node)}`}
    >
      <Handle type="target" position={Position.Left} />
      <span className="citation-dot" />
      <span className="citation-dot-label">{citationNodeLabel(node)}</span>
      {node.depth === 2 && <span className="citation-dot-depth">2</span>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function CitationEdge({
  id,
  source,
  target,
  markerStart,
  style,
}: EdgeProps): React.JSX.Element | null {
  const from = useInternalNode(source),
    to = useInternalNode(target);
  if (!from || !to) return null;
  const ar = (from.measured.width ?? from.width ?? 28) / 2,
    br = (to.measured.width ?? to.width ?? 28) / 2;
  const ax = from.internals.positionAbsolute.x + ar,
    ay = from.internals.positionAbsolute.y + ar;
  const bx = to.internals.positionAbsolute.x + br,
    by = to.internals.positionAbsolute.y + br;
  const length = Math.hypot(bx - ax, by - ay) || 1,
    dx = (bx - ax) / length,
    dy = (by - ay) / length;
  return (
    <BaseEdge
      id={id}
      path={`M ${ax + dx * (ar + 4)} ${ay + dy * (ar + 4)} L ${bx - dx * (br + 2)} ${by - dy * (br + 2)}`}
      markerStart={markerStart}
      style={style}
    />
  );
}

export function buildFlowGraph(
  citationNodes: CitationGraphNode[],
  citationEdges: CitationGraphSnapshot["edges"],
  query: string,
  focusedNodeIds: ReadonlySet<string> = new Set(),
  positions: Map<string, { x: number; y: number }>,
): { nodes: CitationFlowNode[]; edges: Edge[]; layoutKey: string } {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const dimmed = new Set<string>();
  const nodes: CitationFlowNode[] = citationNodes.map((citation) => {
    const haystack = [
      citation.title,
      ...citation.authors,
      citation.doi,
      citation.journal,
      citation.year,
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
    const isDimmed = Boolean(
      (normalizedQuery && !haystack.includes(normalizedQuery)) ||
      (focusedNodeIds.size && !focusedNodeIds.has(citation.id)),
    );
    if (isDimmed) dimmed.add(citation.id);
    const size = citationNodeDiameter(citation);
    return {
      id: citation.id,
      type: "citation",
      position: positions.get(citation.id) ?? { x: 0, y: 0 },
      width: size,
      height: size,
      measured: { width: size, height: size },
      handles: [
        { type: "source", position: Position.Right, x: size, y: size / 2 },
        { type: "target", position: Position.Left, x: 0, y: size / 2 },
      ],
      ariaLabel: citation.title,
      data: { citation, dimmed: isDimmed },
    };
  });
  const byId = new Map(citationNodes.map((node) => [node.id, node]));
  const edges: Edge[] = citationEdges.map((edge) => {
    const source = byId.get(edge.source),
      target = byId.get(edge.target);
    const color =
      edge.relation === "reference"
        ? CITATION_NODE_COLORS.reference
        : edge.relation === "citing"
          ? CITATION_NODE_COLORS.citing
          : source && citationNodeTone(source) === "root"
            ? CITATION_NODE_COLORS.reference
            : CITATION_NODE_COLORS.citing;
    return {
      ...edge,
      type: "citation",
      ariaLabel: `${target?.title ?? ""} 被 ${source?.title ?? ""} 引用`,
      // Data edges are citer -> cited; the displayed arrow is cited -> citer.
      markerStart: {
        type: MarkerType.ArrowClosed,
        width: 13,
        height: 13,
        color,
        orient: "auto-start-reverse",
      },
      style: {
        stroke: color,
        strokeWidth: edge.depth === 2 ? 1 : 1.25,
        strokeDasharray: edge.depth === 2 ? "4 5" : undefined,
        opacity:
          dimmed.has(edge.source) || dimmed.has(edge.target)
            ? 0.09
            : edge.depth === 2
              ? 0.5
              : 0.65,
      },
    };
  });
  return {
    nodes,
    edges,
    layoutKey: `${nodes.map((node) => node.id).join("|")}:${edges.map((edge) => edge.id).join("|")}`,
  };
}
