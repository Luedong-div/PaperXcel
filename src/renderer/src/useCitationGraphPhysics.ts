import { useEffect, useRef, useState } from "react";
import type {
  CitationGraphEdge,
  CitationGraphNode,
} from "../../shared/contracts";
import {
  createCitationGraphPhysics,
  type CitationPositions,
} from "./citationGraphPhysics";

export function useCitationGraphPhysics(
  nodes: CitationGraphNode[],
  edges: CitationGraphEdge[],
  initial: CitationPositions,
  scope: string,
  active: boolean,
) {
  const cache = useRef(new Map<string, CitationPositions>());
  const engine = useRef<
    ReturnType<typeof createCitationGraphPhysics> | undefined
  >(undefined);
  const [frame, setFrame] = useState<{
    scope: string;
    positions: CitationPositions;
    layout: CitationPositions;
    settled: boolean;
  }>({ scope, positions: initial, layout: initial, settled: false });
  useEffect(() => {
    if (!active || !nodes.length) return;
    const cached = cache.current.get(scope) ?? new Map();
    const start = new Map(
      nodes.map((node) => [
        node.id,
        cached.get(node.id) ?? initial.get(node.id) ?? { x: 0, y: 0 },
      ]),
    );
    const physics = createCitationGraphPhysics(
      nodes,
      edges,
      start,
      (positions, settled) => {
        const stored = cache.current.get(scope) ?? new Map();
        for (const [id, position] of positions) stored.set(id, position);
        cache.current.set(scope, stored);
        setFrame({ scope, positions, layout: initial, settled });
      },
    );
    engine.current = physics;
    physics.start();
    // Bound memory while preserving coordinates across filters and workspace tabs.
    if (cache.current.size > 8)
      cache.current.delete(cache.current.keys().next().value!);
    return () => {
      physics.stop();
      if (engine.current === physics) engine.current = undefined;
    };
  }, [nodes, edges, initial, scope, active]);
  return {
    positions: frame.scope === scope ? frame.positions : initial,
    settled: frame.scope === scope && frame.layout === initial && frame.settled,
    move: (id: string, point: { x: number; y: number }) =>
      engine.current?.move(id, point),
    release: (id: string) => engine.current?.release(id),
  };
}
