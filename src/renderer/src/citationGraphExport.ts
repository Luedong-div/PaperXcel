import type {
  CitationGraphEdge,
  CitationGraphNode,
} from "../../shared/contracts";
import { getSmoothStepPath, Position } from "@xyflow/react";

export interface CitationGraphExportLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CitationGraphExportNode
  extends Omit<CitationGraphNode, "abstract"> {
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
  filters: CitationGraphExportFilters;
  nodes: CitationGraphExportInputNode[];
  edges: CitationGraphEdge[];
  errors: string[];
}

export interface CitationGraphExportScene {
  svg: string;
  width: number;
  height: number;
}

const exportPadding = 32;
const exportHeaderHeight = 76;
const exportFooterHeight = 38;
const minimumExportWidth = 960;
const minimumExportHeight = 540;

export function buildCitationGraphExportDocument({
  exportedAt,
  title,
  subtitle,
  sourceUpdatedAt,
  filters,
  nodes,
  edges,
  errors,
}: CitationGraphExportDocumentOptions): CitationGraphExportDocument {
  return {
    schemaVersion: 1,
    exportedAt,
    title,
    subtitle,
    sourceUpdatedAt,
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

export function buildCitationGraphExportScene(
  document: CitationGraphExportDocument,
): CitationGraphExportScene {
  const { nodes, edges, title, subtitle } = document;
  if (!nodes.length) throw new Error("当前图谱没有可导出的节点。");

  const minX = Math.min(...nodes.map((node) => node.layout.x));
  const minY = Math.min(...nodes.map((node) => node.layout.y));
  const maxX = Math.max(
    ...nodes.map((node) => node.layout.x + node.layout.width),
  );
  const maxY = Math.max(
    ...nodes.map((node) => node.layout.y + node.layout.height),
  );
  const graphWidth = maxX - minX;
  const graphHeight = maxY - minY;
  const width = Math.ceil(
    Math.max(minimumExportWidth, graphWidth + exportPadding * 2),
  );
  const height = Math.ceil(
    Math.max(
      minimumExportHeight,
      exportHeaderHeight + graphHeight + exportPadding * 2 + exportFooterHeight,
    ),
  );
  const offsetX = (width - graphWidth) / 2 - minX;
  const offsetY = exportHeaderHeight + exportPadding - minY;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const edgeMarkup = edges
    .map((edge) => {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      if (!source || !target) return "";
      const sourceX =
        source.layout.x + source.layout.width + offsetX;
      const sourceY =
        source.layout.y + source.layout.height / 2 + offsetY;
      const targetX = target.layout.x + offsetX;
      const targetY = target.layout.y + target.layout.height / 2 + offsetY;
      const [path] = getSmoothStepPath({
        sourceX,
        sourceY,
        sourcePosition: Position.Right,
        targetX,
        targetY,
        targetPosition: Position.Left,
      });
      const color = edgeColor(source, target);
      return `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.35" marker-end="url(#${markerId(color)})" opacity="0.88"/>`;
    })
    .join("");

  const nodeMarkup = nodes
    .map((node) => renderExportNode(node, offsetX, offsetY))
    .join("");
  const exportedAtLabel = new Date(document.exportedAt).toLocaleString(
    "zh-CN",
    { hour12: false },
  );

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">`,
    "<defs>",
    '<pattern id="grid" width="26" height="26" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#dfe5e3"/></pattern>',
    renderArrowMarker("arrow-amber", "#d19732"),
    renderArrowMarker("arrow-teal", "#388d87"),
    renderArrowMarker("arrow-gray", "#7f8b85"),
    '<filter id="node-shadow" x="-15%" y="-25%" width="130%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="2.4" flood-color="#26362f" flood-opacity="0.12"/></filter>',
    "</defs>",
    `<rect width="${width}" height="${height}" fill="#f7f9f6"/>`,
    `<rect y="${exportHeaderHeight}" width="${width}" height="${height - exportHeaderHeight}" fill="url(#grid)"/>`,
    `<rect width="${width}" height="${exportHeaderHeight}" fill="#ffffff"/>`,
    `<line x1="0" y1="${exportHeaderHeight - 1}" x2="${width}" y2="${exportHeaderHeight - 1}" stroke="#d9dfda"/>`,
    `<text x="${exportPadding}" y="31" fill="#20322c" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="19" font-weight="700">${escapeXml(title)}</text>`,
    `<text x="${exportPadding}" y="52" fill="#66756e" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="11">${escapeXml(subtitle)}</text>`,
    `<text x="${width - exportPadding}" y="39" text-anchor="end" fill="#829089" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="10">导出于 ${escapeXml(exportedAtLabel)}</text>`,
    `<g class="citation-export-edges">${edgeMarkup}</g>`,
    `<g class="citation-export-nodes">${nodeMarkup}</g>`,
    renderLegend(width, height),
    "</svg>",
  ].join("");

  return { svg, width, height };
}

export function buildCitationGraphInteractiveHtml(
  document: CitationGraphExportDocument,
  scene: CitationGraphExportScene,
): string {
  const safeTitle = escapeHtml(document.title);
  const embeddedDocument = serializeForInlineScript(document);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; color: #26342f; background: #eef2ee; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; letter-spacing: 0; }
    button, a { font: inherit; }
    #stage { position: absolute; inset: 0; overflow: hidden; cursor: grab; touch-action: none; user-select: none; transition: right 160ms ease; }
    body.panel-open #stage { right: min(400px, 38vw); }
    #stage.dragging { cursor: grabbing; }
    #viewport { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; }
    #viewport svg { display: block; max-width: none; box-shadow: 0 14px 42px rgba(30, 47, 39, 0.14); }
    .citation-export-node { cursor: pointer; outline: none; }
    .citation-export-node:hover rect:first-of-type, .citation-export-node:focus rect:first-of-type, .citation-export-node.selected rect:first-of-type { stroke-width: 2.4; }
    .toolbar { position: fixed; z-index: 3; top: 16px; right: 16px; display: flex; gap: 7px; transition: right 160ms ease; }
    body.panel-open .toolbar { right: min(416px, calc(38vw + 16px)); }
    .toolbar button, #close-panel { display: grid; place-items: center; width: 36px; height: 36px; padding: 0; border: 1px solid #b9c9c1; border-radius: 6px; color: #176f68; background: rgba(255, 255, 255, 0.95); cursor: pointer; box-shadow: 0 4px 15px rgba(30, 47, 39, 0.1); }
    .toolbar button:hover, #close-panel:hover { background: #edf8f4; }
    #detail-panel { position: fixed; z-index: 4; top: 0; right: 0; width: min(400px, 38vw); height: 100%; padding: 22px 22px 28px; overflow: auto; border-left: 1px solid #cbd5d0; background: #fff; box-shadow: -10px 0 32px rgba(30, 47, 39, 0.13); transform: translateX(105%); transition: transform 160ms ease; }
    body.panel-open #detail-panel { transform: translateX(0); }
    #close-panel { position: absolute; top: 14px; right: 14px; box-shadow: none; }
    .eyebrow { margin: 0 44px 9px 0; color: #307c72; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    #detail-title { margin: 0 42px 9px 0; font-size: 20px; line-height: 1.35; overflow-wrap: anywhere; }
    #detail-authors { margin: 0; color: #607069; font-size: 13px; line-height: 1.6; }
    #detail-meta { display: flex; flex-wrap: wrap; gap: 6px; margin: 15px 0; }
    #detail-meta span { padding: 4px 7px; border: 1px solid #d9e1dd; border-radius: 4px; color: #586760; background: #f7f9f7; font-size: 11px; }
    .section { padding-top: 16px; margin-top: 16px; border-top: 1px solid #e2e7e4; }
    .section h2 { margin: 0 0 8px; font-size: 13px; }
    #detail-abstract, #detail-citation { margin: 0; color: #3d4b45; font-size: 13px; line-height: 1.75; white-space: pre-wrap; overflow-wrap: anywhere; }
    #detail-facts { display: grid; grid-template-columns: max-content 1fr; gap: 7px 12px; margin: 0; font-size: 12px; }
    #detail-facts dt { color: #78857f; }
    #detail-facts dd { margin: 0; overflow-wrap: anywhere; }
    #detail-links, #relations { display: flex; flex-wrap: wrap; gap: 7px; }
    #detail-links a, #relations button { padding: 6px 9px; border: 1px solid #b9cdc5; border-radius: 5px; color: #176f68; background: #f6fbf9; text-decoration: none; cursor: pointer; font-size: 12px; }
    #detail-links a:hover, #relations button:hover { background: #eaf7f2; }
    .empty { color: #829089; font-size: 12px; }
    @media (max-width: 760px) {
      body.panel-open #stage { right: 0; }
      body.panel-open .toolbar { right: 16px; opacity: 0; pointer-events: none; }
      #detail-panel { width: min(92vw, 400px); }
    }
  </style>
</head>
<body>
  <div class="toolbar" aria-label="图谱控制">
    <button id="zoom-out" type="button" title="缩小" aria-label="缩小">−</button>
    <button id="reset" type="button" title="适应窗口" aria-label="适应窗口">⌖</button>
    <button id="zoom-in" type="button" title="放大" aria-label="放大">+</button>
  </div>
  <div id="stage"><div id="viewport">${scene.svg}</div></div>
  <aside id="detail-panel" aria-hidden="true" aria-label="论文详情">
    <button id="close-panel" type="button" title="关闭详情" aria-label="关闭详情">×</button>
    <p class="eyebrow" id="detail-kind"></p>
    <h1 id="detail-title"></h1>
    <p id="detail-authors"></p>
    <div id="detail-meta"></div>
    <div class="section"><h2>摘要</h2><p id="detail-abstract"></p></div>
    <div class="section"><h2>文献信息</h2><dl id="detail-facts"></dl></div>
    <div class="section" id="citation-section"><h2>原始引文</h2><p id="detail-citation"></p></div>
    <div class="section"><h2>来源链接</h2><div id="detail-links"></div></div>
    <div class="section"><h2>关联论文</h2><div id="relations"></div></div>
  </aside>
  <script id="graph-data" type="application/json">${embeddedDocument}</script>
  <script>
    (() => {
      const data = JSON.parse(document.getElementById("graph-data").textContent);
      const stage = document.getElementById("stage");
      const viewport = document.getElementById("viewport");
      const panel = document.getElementById("detail-panel");
      const graphWidth = ${scene.width};
      const graphHeight = ${scene.height};
      const nodes = new Map(data.nodes.map((node) => [node.id, node]));
      let scale = 1;
      let x = 0;
      let y = 0;
      let drag;
      let selectedId;

      const text = (id, value, fallback = "未提供") => {
        document.getElementById(id).textContent = value || fallback;
      };
      const apply = () => {
        viewport.style.transform = \`translate(\${x}px, \${y}px) scale(\${scale})\`;
      };
      const stageSize = () => ({ width: stage.clientWidth, height: stage.clientHeight });
      const fit = () => {
        const padding = 28;
        const size = stageSize();
        scale = Math.min(1, (size.width - padding * 2) / graphWidth, (size.height - padding * 2) / graphHeight);
        x = (size.width - graphWidth * scale) / 2;
        y = (size.height - graphHeight * scale) / 2;
        apply();
      };
      const zoom = (factor, clientX, clientY) => {
        const rect = stage.getBoundingClientRect();
        const pointerX = (clientX ?? rect.left + rect.width / 2) - rect.left;
        const pointerY = (clientY ?? rect.top + rect.height / 2) - rect.top;
        const graphX = (pointerX - x) / scale;
        const graphY = (pointerY - y) / scale;
        scale = Math.min(4, Math.max(0.08, scale * factor));
        x = pointerX - graphX * scale;
        y = pointerY - graphY * scale;
        apply();
      };
      const appendMeta = (value) => {
        if (value === undefined || value === null || value === "") return;
        const item = document.createElement("span");
        item.textContent = String(value);
        document.getElementById("detail-meta").append(item);
      };
      const appendFact = (label, value) => {
        if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) return;
        const term = document.createElement("dt");
        const description = document.createElement("dd");
        term.textContent = label;
        description.textContent = Array.isArray(value) ? value.join(", ") : String(value);
        document.getElementById("detail-facts").append(term, description);
      };
      const safeUrl = (value) => {
        if (!value) return undefined;
        try {
          const url = new URL(value);
          return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
        } catch { return undefined; }
      };
      const appendLink = (label, value) => {
        const href = safeUrl(value);
        if (!href) return;
        const link = document.createElement("a");
        link.textContent = label;
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        document.getElementById("detail-links").append(link);
      };
      const openNode = (id) => {
        const node = nodes.get(id);
        if (!node) return;
        selectedId = id;
        document.querySelectorAll(".citation-export-node").forEach((element) => element.classList.toggle("selected", element.dataset.nodeId === id));
        text("detail-kind", node.kind === "library" ? "本地资料库论文" : "外部引文论文");
        text("detail-title", node.title, "未命名论文");
        text("detail-authors", node.authors?.join(", "), "作者未提供");
        const meta = document.getElementById("detail-meta");
        meta.replaceChildren();
        appendMeta(node.year);
        appendMeta(node.journal);
        appendMeta(\`被引 \${node.citedByCount ?? 0}\`);
        appendMeta(node.matchStatus ? \`匹配：\${node.matchStatus}\` : undefined);
        text("detail-abstract", node.abstract, "暂无摘要");
        const facts = document.getElementById("detail-facts");
        facts.replaceChildren();
        appendFact("DOI", node.doi);
        appendFact("OpenAlex ID", node.openAlexId);
        appendFact("卷 / 期", [node.volume, node.issue].filter(Boolean).join(" / "));
        appendFact("页码", node.pages);
        appendFact("ISSN", node.issn);
        appendFact("元数据来源", node.metadataSources);
        appendFact("匹配置信度", node.matchConfidence);
        appendFact("文本质量", node.textQuality);
        appendFact("引用方向", [node.referencedByLibrary ? "被本地论文引用" : "", node.citesLibrary ? "引用本地论文" : ""].filter(Boolean).join("；"));
        text("detail-citation", node.rawCitation, "未保留原始引文");
        document.getElementById("citation-section").hidden = !node.rawCitation;
        const links = document.getElementById("detail-links");
        links.replaceChildren();
        appendLink("论文来源", node.sourceUrl);
        appendLink("DOI", node.doi ? \`https://doi.org/\${encodeURIComponent(node.doi)}\` : undefined);
        appendLink("OpenAlex", node.openAlexId?.startsWith("http") ? node.openAlexId : node.openAlexId ? \`https://openalex.org/\${encodeURIComponent(node.openAlexId)}\` : undefined);
        if (!links.children.length) links.append(Object.assign(document.createElement("span"), { className: "empty", textContent: "暂无可用链接" }));
        const relations = document.getElementById("relations");
        relations.replaceChildren();
        const relatedIds = new Set();
        for (const edge of data.edges) {
          if (edge.source === id) relatedIds.add(edge.target);
          if (edge.target === id) relatedIds.add(edge.source);
        }
        for (const relatedId of relatedIds) {
          const related = nodes.get(relatedId);
          if (!related) continue;
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = related.title || "未命名论文";
          button.addEventListener("click", () => openNode(relatedId));
          relations.append(button);
        }
        if (!relations.children.length) relations.append(Object.assign(document.createElement("span"), { className: "empty", textContent: "暂无关联论文" }));
        document.body.classList.add("panel-open");
        panel.setAttribute("aria-hidden", "false");
      };
      const closePanel = () => {
        document.body.classList.remove("panel-open");
        panel.setAttribute("aria-hidden", "true");
        document.querySelectorAll(".citation-export-node").forEach((element) => element.classList.remove("selected"));
        selectedId = undefined;
      };

      stage.addEventListener("wheel", (event) => {
        event.preventDefault();
        zoom(event.deltaY < 0 ? 1.12 : 0.89, event.clientX, event.clientY);
      }, { passive: false });
      stage.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target.closest(".citation-export-node")) return;
        drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x, y };
        stage.setPointerCapture(event.pointerId);
        stage.classList.add("dragging");
      });
      stage.addEventListener("pointermove", (event) => {
        if (!drag || drag.id !== event.pointerId) return;
        x = drag.x + event.clientX - drag.startX;
        y = drag.y + event.clientY - drag.startY;
        apply();
      });
      const stopDrag = (event) => {
        if (!drag || drag.id !== event.pointerId) return;
        drag = undefined;
        stage.classList.remove("dragging");
      };
      stage.addEventListener("pointerup", stopDrag);
      stage.addEventListener("pointercancel", stopDrag);
      stage.addEventListener("dblclick", (event) => { if (!event.target.closest(".citation-export-node")) fit(); });
      document.querySelectorAll(".citation-export-node").forEach((element) => {
        element.addEventListener("click", () => openNode(element.dataset.nodeId));
        element.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openNode(element.dataset.nodeId); }
        });
      });
      document.getElementById("reset").addEventListener("click", fit);
      document.getElementById("zoom-in").addEventListener("click", () => zoom(1.2));
      document.getElementById("zoom-out").addEventListener("click", () => zoom(0.83));
      document.getElementById("close-panel").addEventListener("click", closePanel);
      document.addEventListener("keydown", (event) => { if (event.key === "Escape" && selectedId) closePanel(); });
      window.addEventListener("resize", fit);
      fit();
    })();
  </script>
</body>
</html>`;
}

function renderExportNode(
  node: CitationGraphExportNode,
  offsetX: number,
  offsetY: number,
): string {
  const x = node.layout.x + offsetX;
  const y = node.layout.y + offsetY;
  const style = nodeStyle(node);
  const title = cleanCitationText(node.title) || "未命名论文";
  const author = node.authors[0] ?? node.journal ?? "作者未知";
  const meta = `${node.year ?? "年份未知"} · 被引 ${node.citedByCount ?? 0} · ${author}`;
  const opacity = node.dimmed ? 0.2 : 1;
  return [
    `<g class="citation-export-node" data-node-id="${escapeXml(node.id)}" tabindex="0" role="button" aria-label="查看 ${escapeXml(title)}" opacity="${opacity}" filter="url(#node-shadow)">`,
    `<title>${escapeXml(title)}${node.doi ? `\nDOI: ${escapeXml(node.doi)}` : ""}</title>`,
    `<rect x="${x}" y="${y}" width="${node.layout.width}" height="${node.layout.height}" rx="3" fill="${style.fill}" stroke="${style.border}" stroke-width="1"${style.dashed ? ' stroke-dasharray="5 3"' : ""}/>`,
    `<rect x="${x}" y="${y}" width="4" height="${node.layout.height}" rx="2" fill="${style.accent}"/>`,
    `<text x="${x + 10}" y="${y + 16}" fill="${style.text}" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="9.5" font-weight="700">${escapeXml(truncateSvgText(title, 160, 9.5))}</text>`,
    `<text x="${x + 10}" y="${y + 31}" fill="#78867f" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="7.8">${escapeXml(truncateSvgText(meta, 160, 7.8))}</text>`,
    "</g>",
  ].join("");
}

function nodeStyle(node: CitationGraphExportNode): {
  fill: string;
  border: string;
  accent: string;
  text: string;
  dashed: boolean;
} {
  if (node.kind === "library") {
    return { fill: "#f1faf6", border: "#2b8478", accent: "#1d7167", text: "#213832", dashed: false };
  }
  if (node.matchStatus === "ambiguous") {
    return { fill: "#fffaf1", border: "#d3b178", accent: "#b77b28", text: "#5a4932", dashed: true };
  }
  if (node.matchStatus === "unresolved") {
    return { fill: "#fbfaf8", border: "#c9c2bb", accent: "#9a8f85", text: "#625b55", dashed: true };
  }
  const accent = node.referencedByLibrary && node.citesLibrary
    ? "#5888a1"
    : node.referencedByLibrary
      ? "#d09731"
      : "#3d978e";
  return { fill: "#ffffff", border: "#c4d2cc", accent, text: "#26342f", dashed: false };
}

function edgeColor(
  source: CitationGraphExportNode,
  target: CitationGraphExportNode,
): string {
  if (source.kind === "library" && target.kind === "external") return "#d19732";
  if (source.kind === "external" && target.kind === "library") return "#388d87";
  return "#7f8b85";
}

function markerId(color: string): string {
  if (color === "#d19732") return "arrow-amber";
  if (color === "#388d87") return "arrow-teal";
  return "arrow-gray";
}

function renderArrowMarker(id: string, color: string): string {
  return `<marker id="${id}" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="strokeWidth"><path d="M 0 0 L 9 4.5 L 0 9 z" fill="${color}"/></marker>`;
}

function renderLegend(width: number, height: number): string {
  const y = height - 17;
  const startX = width - exportPadding - 270;
  return [
    '<g font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="9" fill="#65736c">',
    legendItem(startX, y, "#1d7167", "本地资料库"),
    legendItem(startX + 88, y, "#d09731", "参考文献"),
    legendItem(startX + 168, y, "#3d978e", "引用本文"),
    "</g>",
  ].join("");
}

function legendItem(x: number, y: number, color: string, label: string): string {
  return `<rect x="${x}" y="${y - 8}" width="9" height="9" rx="2" fill="${color}"/><text x="${x + 14}" y="${y}">${label}</text>`;
}

function truncateSvgText(value: string, maximumWidth: number, fontSize: number): string {
  let width = 0;
  let result = "";
  for (const character of Array.from(value)) {
    const unit = /[\u2e80-\u9fff\uff00-\uffef]/u.test(character) ? 1 : 0.56;
    if (width + fontSize * unit > maximumWidth - fontSize) return `${result}…`;
    result += character;
    width += fontSize * unit;
  }
  return result;
}

function cleanCitationText(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function serializeForInlineScript(document: CitationGraphExportDocument): string {
  return JSON.stringify(document)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeHtml(value: string): string {
  return escapeXml(value);
}
