import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type {
  CitationGraphEdge,
  CitationGraphNode,
  CitationGraphSnapshot,
  DocumentPageText,
  KnowledgeBaseExportResult,
  KnowledgeBaseRepairProgress,
  LibraryFolder,
  LibraryReview,
  Paper,
  PaperNote,
} from "../shared/contracts";
import type { KnowledgePaperRepairResult } from "./provider";
import type { KnowledgeMarkdownRepairCache } from "./knowledge-markdown-cache";
import {
  buildLibraryReviewExport,
  buildPaperFullTextMarkdown,
  libraryReviewFileName,
  paperExportFolderName,
} from "../shared/knowledge";
import { buildPaperNoteExport } from "../shared/notes";

interface ExportKnowledgeBaseOptions {
  destinationRoot: string;
  papers: Paper[];
  folders: LibraryFolder[];
  notes: PaperNote[];
  reviews: LibraryReview[];
  citationGraph: CitationGraphSnapshot;
  resolvePaperPath: (paperId: string) => string | null;
  readDocumentPages: (paperId: string) => Promise<DocumentPageText[]>;
  signal?: AbortSignal;
  onProgress?: (progress: KnowledgeBaseRepairProgress) => void;
  aiRepair?: {
    readCachedText: (
      paper: Paper,
    ) => Promise<KnowledgeMarkdownRepairCache | null>;
    saveRepairedText: (
      paper: Paper,
      result: KnowledgePaperRepairResult,
      rawPages: DocumentPageText[],
    ) => Promise<KnowledgeMarkdownRepairCache>;
    repairPaper: (
      input: KnowledgeBasePaperRepairInput,
      onStage: (
        phase: "repairing-text" | "repairing-citations",
        detail: string,
      ) => void,
      cachedMarkdown?: string,
    ) => Promise<KnowledgePaperRepairResult>;
  };
}

interface KnowledgeBasePaperRepairInput {
  paper: Paper;
  pdfPath: string;
  markdownPath: string;
  pages: DocumentPageText[];
  citationNodes: CitationGraphNode[];
  citationEdges: CitationGraphEdge[];
}

interface ExportedCitationGraphNode extends CitationGraphNode {
  ai_repair?: {
    model: string;
    confidence: number;
    repaired_at: string;
  };
}

interface ExportIndexPaper {
  id: string;
  title: string;
  authors: string[];
  journal?: string;
  year?: number;
  doi?: string;
  arxiv_id?: string;
  abstract?: string;
  source_url?: string;
  folder: string;
  files: Record<string, string>;
  errors: string[];
}

export async function exportKnowledgeBase(
  options: ExportKnowledgeBaseOptions,
): Promise<KnowledgeBaseExportResult> {
  const generatedAt = new Date();
  const exportName = `PaperXcel-KnowledgeBase-${formatTimestamp(generatedAt)}`;
  const exportPath = join(options.destinationRoot, exportName);
  try {
    return await runKnowledgeBaseExport(options, generatedAt, exportPath);
  } catch (error) {
    if (options.signal?.aborted) {
      await rm(exportPath, { recursive: true, force: true });
    }
    throw error;
  }
}

async function runKnowledgeBaseExport(
  {
    papers,
    folders,
    notes,
    reviews,
    citationGraph,
    resolvePaperPath,
    readDocumentPages,
    signal,
    onProgress,
    aiRepair,
  }: ExportKnowledgeBaseOptions,
  generatedAt: Date,
  exportPath: string,
): Promise<KnowledgeBaseExportResult> {
  throwIfAborted(signal);
  const papersPath = join(exportPath, "papers");
  const reviewsPath = join(exportPath, "reviews");
  await Promise.all([
    mkdir(papersPath, { recursive: true }),
    mkdir(reviewsPath, { recursive: true }),
  ]);

  const noteByPaperId = new Map(notes.map((note) => [note.paperId, note]));
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const indexPapers: ExportIndexPaper[] = [];
  const exportedCitationGraph = structuredClone(citationGraph) as {
    nodes: ExportedCitationGraphNode[];
    edges: CitationGraphEdge[];
    updatedAt?: string;
    errors: string[];
  };
  const citationNodeById = new Map(
    exportedCitationGraph.nodes.map((node) => [node.id, node]),
  );
  const repairIssues: KnowledgeBaseExportResult["repairIssues"] = [];
  let repairedPaperCount = 0;
  let repairedCitationNodeCount = 0;
  const repairedCitationNodeIds = new Set<string>();

  onProgress?.({
    phase: "preparing",
    completed: 0,
    total: papers.length,
    detail: aiRepair ? "正在准备 AI 修复导出" : "正在准备知识库导出",
  });

  for (const [index, paper] of papers.entries()) {
    throwIfAborted(signal);
    onProgress?.({
      phase: "extracting",
      completed: index,
      total: papers.length,
      paperId: paper.id,
      paperTitle: paper.title,
      detail: `正在读取 ${paper.title}`,
    });
    const folderName = paperExportFolderName(paper, index);
    const paperPath = join(papersPath, folderName);
    await mkdir(paperPath, { recursive: true });
    const files: Record<string, string> = {};
    const errors: string[] = [];

    const pdfPath = resolvePaperPath(paper.id);
    if (pdfPath) {
      await copyFile(pdfPath, join(paperPath, "paper.pdf"));
      throwIfAborted(signal);
      files.pdf = `papers/${folderName}/paper.pdf`;
    }

    try {
      const pages = await readDocumentPages(paper.id);
      throwIfAborted(signal);
      if (pages.length) {
        let exportedMarkdown = buildPaperFullTextMarkdown(paper, pages);
        let repairResult: KnowledgePaperRepairResult | undefined;
        let textCache: KnowledgeMarkdownRepairCache | null = null;
        let textSource: "cache" | "generated" | "raw" = "raw";
        let textWasAiRepaired = false;
        if (aiRepair) {
          const paperNodeId = `paper:${paper.id}`;
          const citationEdges = exportedCitationGraph.edges.filter(
            (edge) =>
              edge.source === paperNodeId &&
              edge.target.startsWith("external:"),
          );
          const citationNodeIds = new Set(
            citationEdges.map((edge) => edge.target),
          );
          const citationNodes = [...citationNodeIds]
            .map((nodeId) => citationNodeById.get(nodeId))
            .filter((node): node is ExportedCitationGraphNode => Boolean(node));
          try {
            if (!pdfPath) {
              throw new Error("论文 PDF 文件不存在，无法准备 full.md。");
            }
            const markdownPath = join(paperPath, "full.md");
            await writeFile(
              markdownPath,
              ensureTrailingNewline(exportedMarkdown),
              "utf8",
            );
            textCache = await aiRepair.readCachedText(paper);
            if (textCache) textSource = "cache";
            repairResult = await aiRepair.repairPaper(
              {
                paper,
                pdfPath,
                markdownPath,
                pages,
                citationNodes,
                citationEdges,
              },
              (phase, detail) =>
                onProgress?.({
                  phase,
                  completed: index,
                  total: papers.length,
                  paperId: paper.id,
                  paperTitle: paper.title,
                  detail,
                }),
              textCache?.markdown,
            );
            throwIfAborted(signal);
            exportedMarkdown = textCache?.markdown ?? repairResult.markdown;
            textWasAiRepaired = Boolean(textCache || repairResult.textProtocol);
            let cacheWriteWarning = "";
            if (!textCache && repairResult.textProtocol) {
              try {
                textCache = await aiRepair.saveRepairedText(
                  paper,
                  repairResult,
                  pages,
                );
                textSource = "generated";
                exportedMarkdown = textCache.markdown;
                textWasAiRepaired = true;
              } catch (error) {
                cacheWriteWarning = `AI 正文缓存写入失败：${errorMessage(error)}`;
              }
            }
            const repairedAt = new Date().toISOString();
            let changedCitationNodes = 0;
            for (const patch of repairResult.citationPatches) {
              const node = citationNodeById.get(patch.id);
              if (!node || node.kind !== "external") continue;
              if (
                node.ai_repair &&
                node.ai_repair.confidence > patch.confidence
              ) {
                continue;
              }
              if (!citationPatchChangesNode(node, patch.changes)) continue;
              Object.assign(node, patch.changes);
              node.ai_repair = {
                model: repairResult.model,
                confidence: patch.confidence,
                repaired_at: repairedAt,
              };
              changedCitationNodes += 1;
              repairedCitationNodeIds.add(node.id);
            }
            repairedCitationNodeCount = repairedCitationNodeIds.size;
            if (textWasAiRepaired || changedCitationNodes) {
              repairedPaperCount += 1;
            }
            const repairWarnings = [
              ...new Set([
                ...(textCache?.warnings ?? []),
                ...repairResult.warnings,
                ...(cacheWriteWarning ? [cacheWriteWarning] : []),
              ]),
            ];
            if (repairWarnings.length) {
              const message = repairWarnings.join("；");
              errors.push(message);
              repairIssues.push({
                paperId: paper.id,
                paperTitle: paper.title,
                message,
              });
            }
            await writeJson(join(paperPath, "ai_repair.json"), {
              model: repairResult.model,
              protocol: repairResult.protocol ?? textCache?.protocol,
              repaired_at: repairedAt,
              text: {
                source: textSource,
                input: "full.md",
                page_count:
                  textCache?.pageCount ??
                  repairResult.pageCount ??
                  pages.length,
                model: textCache?.model ?? repairResult.model,
                protocol: textCache?.protocol ?? repairResult.textProtocol,
                repaired_at: textCache?.repairedAt,
              },
              citations: {
                reviewed_node_count: repairResult.reviewedCitationNodeCount,
                changed_node_count: changedCitationNodes,
              },
              warnings: repairWarnings,
            });
            files.repair = `papers/${folderName}/ai_repair.json`;
          } catch (error) {
            throwIfAborted(signal);
            const message = `AI 修复失败，已保留原始导出：${errorMessage(error)}`;
            errors.push(message);
            repairIssues.push({
              paperId: paper.id,
              paperTitle: paper.title,
              message,
            });
          }
        }

        onProgress?.({
          phase: "writing",
          completed: index,
          total: papers.length,
          paperId: paper.id,
          paperTitle: paper.title,
          detail: "正在写入论文导出文件",
        });
        const writes = [
          writeFile(
            join(paperPath, "full.md"),
            ensureTrailingNewline(exportedMarkdown),
            "utf8",
          ),
          textWasAiRepaired
            ? writeJson(join(paperPath, "content.json"), {
                format: "paperxcel-document-markdown",
                version: 2,
                parser: "AI repair of PaperXcel full.md",
                page_count:
                  textCache?.pageCount ??
                  repairResult?.pageCount ??
                  pages.length,
                markdown: ensureTrailingNewline(exportedMarkdown),
                ai_repaired: true,
                model: textCache?.model ?? repairResult?.model,
                protocol: textCache?.protocol ?? repairResult?.textProtocol,
                repaired_at: textCache?.repairedAt,
              })
            : writeJson(join(paperPath, "content.json"), {
                format: "paperxcel-document-pages",
                version: 1,
                parser: "PaperXcel PDF.js layout reconstruction",
                page_count: pages.length,
                pages,
                ai_repaired: false,
              }),
        ];
        if (textWasAiRepaired) {
          writes.push(
            writeFile(
              join(paperPath, "full.raw.md"),
              buildPaperFullTextMarkdown(paper, pages),
              "utf8",
            ),
            writeJson(join(paperPath, "content.raw.json"), {
              parser: "PaperXcel PDF.js layout reconstruction",
              page_count: pages.length,
              pages,
            }),
          );
        }
        await Promise.all([...writes]);
        throwIfAborted(signal);
        files.markdown = `papers/${folderName}/full.md`;
        files.content = `papers/${folderName}/content.json`;
        if (textWasAiRepaired) {
          files.markdown_raw = `papers/${folderName}/full.raw.md`;
          files.content_raw = `papers/${folderName}/content.raw.json`;
        }
      }
    } catch (error) {
      throwIfAborted(signal);
      errors.push(errorMessage(error));
    }

    const note = noteByPaperId.get(paper.id);
    if (note?.content.trim()) {
      await writeFile(
        join(paperPath, "notes.md"),
        buildPaperNoteExport(paper, note),
        "utf8",
      );
      files.notes = `papers/${folderName}/notes.md`;
    }

    indexPapers.push({
      id: paper.id,
      title: paper.title,
      authors: [...paper.authors],
      journal: paper.journal,
      year: paper.year,
      doi: paper.doi,
      arxiv_id: paper.arxivId,
      abstract: paper.abstract,
      source_url: paper.sourceUrl,
      folder: resolveFolderPath(paper.folderId, folderById),
      files,
      errors,
    });
    onProgress?.({
      phase: "writing",
      completed: index + 1,
      total: papers.length,
      paperId: paper.id,
      paperTitle: paper.title,
      detail: `已完成 ${index + 1}/${papers.length} 篇`,
    });
  }

  const exportedReviews = reviews.filter((review) =>
    review.paperIds.every((paperId) =>
      papers.some((paper) => paper.id === paperId),
    ),
  );
  for (const review of exportedReviews) {
    throwIfAborted(signal);
    await writeFile(
      join(reviewsPath, libraryReviewFileName(review)),
      buildLibraryReviewExport(review, papers),
      "utf8",
    );
  }

  const manifest = {
    format: "paperxcel-knowledge-base",
    version: 3,
    generated_at: generatedAt.toISOString(),
    paper_count: papers.length,
    note_count: notes.filter(
      (note) =>
        note.content.trim() &&
        papers.some((paper) => paper.id === note.paperId),
    ).length,
    review_count: exportedReviews.length,
    ai_repair: aiRepair
      ? {
          enabled: true,
          repaired_paper_count: repairedPaperCount,
          repaired_citation_node_count: repairedCitationNodeCount,
          issue_count: repairIssues.length,
        }
      : {
          enabled: false,
          repaired_paper_count: 0,
          repaired_citation_node_count: 0,
          issue_count: 0,
        },
  };
  const citationGraphOutput = aiRepair
    ? {
        ...exportedCitationGraph,
        ai_repair: {
          repaired_at: new Date().toISOString(),
          repaired_paper_count: repairedPaperCount,
          repaired_node_count: repairedCitationNodeCount,
          topology_changed: false,
        },
      }
    : exportedCitationGraph;
  throwIfAborted(signal);
  onProgress?.({
    phase: "finalizing",
    completed: papers.length,
    total: papers.length,
    detail: "正在写入索引并校验导出文件",
  });
  const rootWrites = [
    writeJson(join(exportPath, "manifest.json"), manifest),
    writeJson(join(exportPath, "metadata_index.json"), {
      ...manifest,
      folders,
      papers: indexPapers,
    }),
    writeJson(join(exportPath, "citation_graph.json"), citationGraphOutput),
    writeJson(join(exportPath, "reviews.json"), exportedReviews),
    writeFile(join(exportPath, "query.mjs"), QUERY_SCRIPT, "utf8"),
    writeFile(
      join(exportPath, "README.md"),
      buildReadme(manifest.paper_count, manifest.note_count),
      "utf8",
    ),
    writeFile(join(exportPath, "AGENTS.md"), AGENT_GUIDE, "utf8"),
  ];
  if (aiRepair) {
    rootWrites.push(
      writeJson(join(exportPath, "citation_graph.raw.json"), citationGraph),
    );
  }
  await Promise.all(rootWrites);
  throwIfAborted(signal);
  const validation = await validateKnowledgeBaseExport(
    exportPath,
    manifest,
    indexPapers,
  );
  await writeJson(join(exportPath, "validation.json"), {
    checked_at: new Date().toISOString(),
    passed: validation.errors.length === 0,
    checked_files: validation.checkedFiles,
    warnings: validation.warnings,
    errors: validation.errors,
  });
  if (validation.errors.length) {
    throw new Error(
      `知识库导出校验失败：${validation.errors.slice(0, 3).join("；")}`,
    );
  }

  onProgress?.({
    phase: "complete",
    completed: papers.length,
    total: papers.length,
    detail: "知识库导出完成",
  });

  return {
    path: exportPath,
    paperCount: papers.length,
    noteCount: manifest.note_count,
    reviewCount: exportedReviews.length,
    aiRepair: Boolean(aiRepair),
    repairedPaperCount,
    repairedCitationNodeCount,
    repairIssues,
    validation: {
      checkedFiles: validation.checkedFiles,
      warnings: validation.warnings,
    },
  };
}

async function validateKnowledgeBaseExport(
  exportPath: string,
  manifest: { paper_count: number },
  papers: ExportIndexPaper[],
): Promise<{
  checkedFiles: number;
  warnings: string[];
  errors: string[];
}> {
  const errors: string[] = [];
  const warnings = papers.flatMap((paper) =>
    paper.errors.map((message) => `${paper.title}：${message}`),
  );
  const referencedPaths = new Set([
    "manifest.json",
    "metadata_index.json",
    "citation_graph.json",
    "reviews.json",
    "query.mjs",
    "README.md",
    "AGENTS.md",
    ...papers.flatMap((paper) => Object.values(paper.files)),
  ]);
  let checkedFiles = 0;
  for (const relativePath of referencedPaths) {
    const absolutePath = join(exportPath, relativePath);
    try {
      const info = await stat(absolutePath);
      if (!info.isFile() || info.size === 0) {
        errors.push(`${relativePath} 为空或不是文件`);
        continue;
      }
      checkedFiles += 1;
      if (relativePath.endsWith(".json")) {
        JSON.parse(await readFile(absolutePath, "utf8"));
      }
      if (relativePath.endsWith(".md")) {
        const markdown = await readFile(absolutePath, "utf8");
        if (!markdown.trim()) errors.push(`${relativePath} 没有 Markdown 内容`);
      }
    } catch (error) {
      errors.push(`${relativePath} 无法读取：${errorMessage(error)}`);
    }
  }
  if (papers.length !== manifest.paper_count) {
    errors.push("metadata_index.json 的论文数量与 manifest.json 不一致");
  }
  return { checkedFiles, warnings, errors };
}

function citationPatchChangesNode(
  node: CitationGraphNode,
  changes: Record<string, unknown>,
): boolean {
  return Object.entries(changes).some(([key, value]) => {
    if (value === undefined) return false;
    return (
      JSON.stringify(node[key as keyof CitationGraphNode]) !==
      JSON.stringify(value)
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("Knowledge-base export aborted", "AbortError");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureTrailingNewline(value: string): string {
  return `${value.trimEnd()}\n`;
}

function resolveFolderPath(
  folderId: string | undefined,
  folderById: Map<string, LibraryFolder>,
): string {
  if (!folderId) return "";
  const names: string[] = [];
  const visited = new Set<string>();
  let current = folderById.get(folderId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    names.unshift(current.name);
    current = current.parentId ? folderById.get(current.parentId) : undefined;
  }
  return names.join("/");
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function buildReadme(paperCount: number, noteCount: number): string {
  return `# PaperXcel Knowledge Base

生成内容：${paperCount} 篇论文，${noteCount} 篇阅读笔记。

## 目录

- \`papers/<序号-标题>/paper.pdf\`：原始 PDF
- \`papers/<序号-标题>/full.md\`：正式全文；AI 修复成功时为模型读取并修复 full.md 后的 Markdown
- \`papers/<序号-标题>/content.json\`：正式全文的结构化记录；AI 版包含完整 Markdown 与模型信息
- \`papers/<序号-标题>/full.raw.md\`：仅在 AI 修复成功时保留的 PDF.js 原始全文
- \`papers/<序号-标题>/content.raw.json\`：仅在 AI 修复成功时保留的 PDF.js 原始页面文本
- \`papers/<序号-标题>/ai_repair.json\`：单篇 AI 修复记录、模型与警告
- \`papers/<序号-标题>/notes.md\`：PaperXcel 阅读笔记
- \`metadata_index.json\`：全库元数据索引
- \`citation_graph.json\`：正式引文图谱；AI 只校对现有节点元数据，不改引用边
- \`citation_graph.raw.json\`：AI 修复导出时保留的原始引文图谱
- \`reviews/\`：全库综述
- \`query.mjs\`：离线查询脚本
- \`AGENTS.md\`：供 Codex 使用的知识库说明
- \`validation.json\`：导出文件完整性校验结果

## 查询

\`\`\`powershell
node query.mjs --list
node query.mjs --search "embedding"
node query.mjs --doi "10.xxxx/xxxx"
node query.mjs --cite "10.xxxx/xxxx"
node query.mjs --cited-by "10.xxxx/xxxx"
\`\`\`
`;
}

const AGENT_GUIDE = `# PaperXcel Knowledge Base

这是一个由 PaperXcel 导出、供 Codex 分析的本地论文知识库。

优先从 \`metadata_index.json\` 定位论文，再读取对应目录中的
\`notes.md\` 和 \`full.md\`。引用关系位于 \`citation_graph.json\`。
回答涉及论文原文时，应优先使用 \`full.md\` 中的
\`<!-- page: N -->\` 页面标记。

如果目录中存在 \`*.raw.*\`，正式文件是 AI 修复后的版本，raw 文件是
PDF.js 原始抽取结果；没有 raw 文件表示当前正式文件就是本地抽取版。
遇到关键公式、数字、DOI 或引用关系冲突时，必须
回看 raw 文件和 \`paper.pdf\`。引文图谱的 AI 修复只校对节点元数据，
不会修改引用边。

可以运行 \`node query.mjs --list\`、\`--search\`、\`--doi\`、
\`--cite\` 和 \`--cited-by\` 快速查询。
`;

const QUERY_SCRIPT = `import { readFile } from "node:fs/promises";

const base = new URL("./", import.meta.url);
const index = JSON.parse(await readFile(new URL("metadata_index.json", base), "utf8"));
const graph = JSON.parse(await readFile(new URL("citation_graph.json", base), "utf8"));
const args = process.argv.slice(2);
const command = args[0] || "--list";
const value = (args[1] || "").toLowerCase();

const papers = index.papers || [];
const byId = new Map(papers.map((paper) => [paper.id, paper]));
const byDoi = new Map(papers.filter((paper) => paper.doi).map((paper) => [paper.doi.toLowerCase(), paper]));

function printPaper(paper) {
  console.log(JSON.stringify(paper, null, 2));
}

if (command === "--list") {
  for (const paper of papers) {
    console.log([paper.title, paper.year, paper.doi].filter(Boolean).join(" | "));
  }
} else if (command === "--search") {
  for (const paper of papers.filter((item) =>
    JSON.stringify(item).toLowerCase().includes(value)
  )) printPaper(paper);
} else if (command === "--doi") {
  const paper = byDoi.get(value);
  if (paper) printPaper(paper);
  else process.exitCode = 1;
} else if (command === "--cite" || command === "--cited-by") {
  const paper = byDoi.get(value);
  if (!paper) process.exitCode = 1;
  else {
    const nodeId = "paper:" + paper.id;
    const edges = (graph.edges || []).filter((edge) =>
      command === "--cite" ? edge.source === nodeId : edge.target === nodeId
    );
    const relatedIds = edges.map((edge) =>
      command === "--cite" ? edge.target : edge.source
    );
    for (const id of relatedIds) {
      if (id.startsWith("paper:")) {
        const related = byId.get(id.slice(6));
        if (related) printPaper(related);
      } else {
        const node = (graph.nodes || []).find((item) => item.id === id);
        if (node) console.log(JSON.stringify(node, null, 2));
      }
    }
  }
} else {
  console.error("Usage: node query.mjs --list|--search <text>|--doi <doi>|--cite <doi>|--cited-by <doi>");
  process.exitCode = 1;
}
`;
