import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from "d3-force";
import type {
  CitationGraphEdge,
  CitationGraphNode,
} from "../../shared/contracts";
import {
  citationNodeDiameter,
  citationNodeLabel,
  citationNodeTone,
} from "./citationGraphLayout";

export interface CitationParticle extends SimulationNodeDatum {
  id: string;
  x: number;
  y: number;
  radius: number;
  collisionRadius: number;
  anchorX: number;
  anchorY: number;
  root: boolean;
}
export type CitationPositions = Map<string, { x: number; y: number }>;

/** Resolve overlaps after integration, including the frame in which the user drags a node. */
export function separateCitationParticles(
  particles: CitationParticle[],
  iterations = 4,
): void {
  const cellSize = Math.max(
    1,
    ...particles.map((node) => node.collisionRadius * 2),
  );
  for (let iteration = 0; iteration < iterations; iteration++) {
    const cells = new Map<
      string,
      Array<{ node: CitationParticle; index: number }>
    >();
    particles.forEach((node, index) => {
      const key = `${Math.floor(node.x / cellSize)},${Math.floor(node.y / cellSize)}`;
      const bucket = cells.get(key) ?? [];
      bucket.push({ node, index });
      cells.set(key, bucket);
    });
    let overlaps = false;
    particles.forEach((a, index) => {
      const gx = Math.floor(a.x / cellSize),
        gy = Math.floor(a.y / cellSize);
      for (let ox = -1; ox <= 1; ox++)
        for (let oy = -1; oy <= 1; oy++) {
          for (const { node: b, index: otherIndex } of cells.get(
            `${gx + ox},${gy + oy}`,
          ) ?? []) {
            if (otherIndex <= index) continue;
            const dx = b.x - a.x,
              dy = b.y - a.y;
            const distance = Math.hypot(dx, dy);
            const required = a.collisionRadius + b.collisionRadius;
            if (distance >= required - 0.01) continue;
            const aHeld = a.fx != null,
              bHeld = b.fx != null;
            if (aHeld && bHeld) continue;
            overlaps = true;
            const angle = (index + 1) * 2.399963229728653;
            const ux = distance > 0.001 ? dx / distance : Math.cos(angle);
            const uy = distance > 0.001 ? dy / distance : Math.sin(angle);
            const correction = required - distance + 0.02;
            const aShare = aHeld ? 0 : bHeld ? 1 : 0.5;
            const bShare = bHeld ? 0 : aHeld ? 1 : 0.5;
            a.x -= ux * correction * aShare;
            a.y -= uy * correction * aShare;
            b.x += ux * correction * bShare;
            b.y += uy * correction * bShare;
          }
        }
    });
    if (!overlaps) break;
  }
}

export function createCitationGraphPhysics(
  nodes: CitationGraphNode[],
  edges: CitationGraphEdge[],
  initial: CitationPositions,
  onFrame: (positions: CitationPositions, settled: boolean) => void,
) {
  const particles: CitationParticle[] = nodes.map((node) => {
    const radius = citationNodeDiameter(node) / 2;
    const point = initial.get(node.id) ?? { x: 0, y: 0 };
    const labelWidth = Math.min(120, citationNodeLabel(node).length * 6.1);
    const tone = citationNodeTone(node);
    const targetDistance = node.depth === 2 ? 155 : 100;
    return {
      id: node.id,
      x: point.x + radius,
      y: point.y + radius,
      radius,
      collisionRadius: Math.max(radius + 8, Math.min(44, labelWidth / 2 + 5)),
      anchorX:
        tone === "root"
          ? point.x + radius
          : tone === "reference"
            ? -targetDistance
            : tone === "citing"
              ? targetDistance
              : 0,
      anchorY:
        tone === "root"
          ? point.y + radius
          : tone === "both"
            ? -targetDistance
            : 0,
      root: tone === "root",
    };
  });
  const byId = new Map(particles.map((node) => [node.id, node]));
  const links = edges
    .filter((edge) => byId.has(edge.source) && byId.has(edge.target))
    .map((edge) => {
      const a = byId.get(edge.source)!,
        b = byId.get(edge.target)!;
      return {
        source: edge.source,
        target: edge.target,
        distance:
          a.collisionRadius + b.collisionRadius + (edge.depth === 2 ? 24 : 36),
      };
    });
  const xForce = forceX<CitationParticle>((node) => node.anchorX).strength(
    (node) => (node.root ? 0.18 : 0.055),
  );
  const yForce = forceY<CitationParticle>((node) => node.anchorY).strength(
    (node) => (node.root ? 0.18 : 0.045),
  );
  const simulation = forceSimulation(particles)
    .stop()
    .force(
      "charge",
      forceManyBody<CitationParticle>().strength(-32).distanceMax(220),
    )
    .force(
      "links",
      forceLink<CitationParticle, (typeof links)[number]>(links)
        .id((node) => node.id)
        .distance((link) => link.distance)
        .strength(0.14),
    )
    .force("x", xForce)
    .force("y", yForce)
    .force(
      "collision",
      forceCollide<CitationParticle>((node) => node.collisionRadius)
        .strength(1)
        .iterations(4),
    )
    .velocityDecay(0.36)
    .alphaDecay(0.032)
    .alphaMin(0.004);
  let stopped = false;
  const positions = (): CitationPositions =>
    new Map(
      particles.map((node) => [
        node.id,
        { x: node.x - node.radius, y: node.y - node.radius },
      ]),
    );
  const publish = (settled = false) => {
    if (!stopped) {
      separateCitationParticles(particles);
      onFrame(positions(), settled);
    }
  };
  simulation.on("tick", () => publish()).on("end", () => publish(true));
  return {
    particles,
    positions,
    start() {
      stopped = false;
      // Settle initial collisions before the first paint, then animate the remaining motion.
      for (let i = 0; i < 18; i++) {
        simulation.tick();
        separateCitationParticles(particles);
      }
      publish();
      simulation.alpha(0.45).restart();
    },
    move(id: string, point: { x: number; y: number }) {
      const node = byId.get(id);
      if (!node) return;
      node.fx = node.x = point.x + node.radius;
      node.fy = node.y = point.y + node.radius;
      node.vx = 0;
      node.vy = 0;
      simulation.alphaTarget(0.28).alpha(0.65).restart();
      publish();
    },
    release(id: string) {
      const node = byId.get(id);
      if (!node) return;
      node.anchorX = node.x;
      node.anchorY = node.y;
      node.fx = null;
      node.fy = null;
      xForce.x((particle) => particle.anchorX);
      yForce.y((particle) => particle.anchorY);
      simulation.alphaTarget(0).alpha(0.5).restart();
    },
    settle(ticks = 240) {
      simulation.stop();
      for (let i = 0; i < ticks; i++) {
        simulation.tick();
        separateCitationParticles(particles);
      }
      publish(true);
    },
    stop() {
      stopped = true;
      simulation.stop();
      simulation.on("tick", null).on("end", null);
    },
  };
}
