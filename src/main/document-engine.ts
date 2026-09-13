import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import DOMMatrixShim from "@thednp/dommatrix";
import type { DocumentPageText } from "../shared/contracts";
import {
  normalizePdfPageText,
  reconstructPdfPageText,
  type PdfLayoutTextItem,
} from "./pdf-layout";
import { extractNumberedReferenceCitations } from "./reference-citations";

const MAX_CHUNK_CHARS = 1_600;
const CHUNK_OVERLAP_CHARS = 180;
const TEXT_SEARCH_PROFILE = "fts5-fuzzy-v1";
const mainDirectory = dirname(fileURLToPath(import.meta.url));

interface Chunk {
  chunkId: string;
  page: number;
  text: string;
  bbox: number[];
}

interface SearchHit {
  chunk_id: string;
  page: number;
  text: string;
  score: number;
  paper_id?: string;
}

interface ExtractResult {
  page_count: number;
  title_guess?: string;
  authors_guess?: string[];
  journal_guess?: string;
  year_guess?: number;
  doi_guess?: string;
  chunk_count: number;
}

interface MarkdownReindexResult {
  page_count: number;
  chunk_count: number;
  updated: boolean;
}

interface IndexSource {
  kind: "pdf" | "markdown";
  path: string;
  digest?: string;
}

type PdfTextItem = PdfLayoutTextItem;

async function loadPdfJs() {
  // PDF.js normally obtains DOMMatrix from a native Canvas package in Node.
  // Text extraction only needs the matrix API, so keep the portable build
  // small by installing a pure JavaScript shim before PDF.js is evaluated.
  if (typeof globalThis.DOMMatrix === "undefined") {
    globalThis.DOMMatrix = DOMMatrixShim;
  }
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    join(mainDirectory, "pdf.worker.min.mjs"),
  ).toString();
  return pdfjs;
}

export class DocumentEngine {
  constructor(
    private readonly standardFontDirectory: string,
    private readonly wasmDirectory: string,
    private readonly sendProgress: (payload: {
      paper_id: string;
      stage: string;
      progress: number;
    }) => void,
  ) {}

  async health(): Promise<{
    available: boolean;
    node: string;
    pdfjs: boolean;
    searchMode: "fuzzy-text";
  }> {
    return {
      available: true,
      node: process.version,
      pdfjs: true,
      searchMode: "fuzzy-text",
    };
  }

  async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (method === "health") return this.health();
    if (method === "extract") return this.extract(params);
    if (method === "reindex_markdown") return this.reindexMarkdown(params);
    if (method === "search") return this.search(params);
    if (method === "search_library") return this.searchLibrary(params);
    if (method === "document_text") return this.readDocumentPages(params);
    if (method === "reference_dois") return this.extractReferenceDois(params);
    if (method === "reference_citations")
      return this.extractReferenceCitations(params);
    throw new Error(`Unknown document engine method: ${method}`);
  }

  private async extract(
    params: Record<string, unknown>,
  ): Promise<ExtractResult> {
    const paperId = String(params.paper_id);
    const pdfPath = String(params.pdf_path);
    const indexDir = String(params.index_dir);
    if (!pdfPath || !existsSync(pdfPath))
      throw new Error("PDF file does not exist.");
    if (!indexDir) throw new Error("Index directory is required.");
    await mkdir(indexDir, { recursive: true });

    const pdfjs = await loadPdfJs();
    const loadingTask = pdfjs.getDocument({
      url: pdfPath,
      standardFontDataUrl: toPdfJsDirectoryUrl(this.standardFontDirectory),
      wasmUrl: toPdfJsDirectoryUrl(this.wasmDirectory),
    });
    const document = await loadingTask.promise;
    const chunks: Chunk[] = [];
    let firstPageText = "";
    let titleGuess: string | undefined;
    let doiText = "";

    try {
      for (let pageIndex = 0; pageIndex < document.numPages; pageIndex += 1) {
        const page = await document.getPage(pageIndex + 1);
        const textContent = await page.getTextContent();
        const items = textContent.items
          .filter((item) => "str" in item && typeof item.str === "string")
          .map((item) => item as PdfTextItem);
        const viewport = page.getViewport({ scale: 1 });
        const pageText = reconstructPdfPageText(items, viewport.width);
        if (pageIndex === 0) {
          firstPageText = pageText;
          titleGuess = guessTitle(items, pageText);
        }
        if (pageIndex < 4) doiText += `\n${pageText}`;
        chunks.push(...splitChunks(paperId, pageIndex + 1, pageText));
        this.sendProgress({
          paper_id: paperId,
          stage: `Parsing page ${pageIndex + 1} / ${document.numPages}`,
          progress:
            8 +
            Math.floor(((pageIndex + 1) / Math.max(document.numPages, 1)) * 54),
        });
      }
    } finally {
      await loadingTask.destroy();
    }

    if (!chunks.length) {
      throw new Error(
        "No extractable PDF text was found. Scanned PDFs cannot be indexed.",
      );
    }

    this.sendProgress({
      paper_id: paperId,
      stage: "Building local index",
      progress: 68,
    });
    this.writeIndex(join(indexDir, `${paperId}.sqlite3`), chunks, {
      kind: "pdf",
      path: pdfPath,
    });
    this.sendProgress({
      paper_id: paperId,
      stage: "Document index complete",
      progress: 100,
    });

    return {
      page_count: document.numPages,
      title_guess: titleGuess,
      journal_guess: guessJournal(firstPageText),
      year_guess: guessYear(firstPageText),
      doi_guess: guessDoi(`${doiText}\n${firstPageText}`),
      chunk_count: chunks.length,
    };
  }

  private async reindexMarkdown(
    params: Record<string, unknown>,
  ): Promise<MarkdownReindexResult> {
    const paperId = String(params.paper_id ?? "").trim();
    const markdownPath = String(params.markdown_path ?? "").trim();
    const indexDir = String(params.index_dir ?? "").trim();
    if (!paperId) throw new Error("Paper ID is required.");
    if (!markdownPath || !existsSync(markdownPath)) {
      throw new Error("Markdown file does not exist.");
    }
    if (!indexDir) throw new Error("Index directory is required.");
    await mkdir(indexDir, { recursive: true });

    // AI 修复后的 full.md 是新的正文来源。先按页面标记还原页码，再沿用
    // 与 PDF 索引相同的切片和 FTS 流程，最终覆盖该论文原来的 SQLite。
    const markdown = await readFile(markdownPath, "utf8");
    const pages = parseMarkdownPages(markdown);
    const chunks = pages.flatMap((page) =>
      splitChunks(paperId, page.page, page.text),
    );
    if (!chunks.length && params.allow_empty !== true) {
      throw new Error("Markdown 文件中没有可索引的文本。请检查 markdown 文件.");
    }

    const indexPath = join(indexDir, `${paperId}.sqlite3`);
    // source_digest 用来判断 full.md 是否真的变化，避免每次启动都重建索引。
    const digest = createHash("sha256").update(markdown).digest("hex");
    const current = readIndexSummary(indexPath);
    if (
      !params.force &&
      current?.sourceKind === "markdown" &&
      current.sourceDigest === digest
    ) {
      return {
        page_count: current.pageCount,
        chunk_count: current.chunkCount,
        updated: false,
      };
    }

    this.writeIndex(indexPath, chunks, {
      kind: "markdown",
      path: markdownPath,
      digest,
    });
    return {
      page_count: pages.length,
      chunk_count: chunks.length,
      updated: true,
    };
  }

  private async search(params: Record<string, unknown>): Promise<SearchHit[]> {
    const paperId = String(params.paper_id);
    const indexDir = String(params.index_dir ?? "");
    const indexPath = indexDir
      ? join(indexDir, `${paperId}.sqlite3`)
      : join(
          process.env.APPDATA ?? "",
          "PaperXcel",
          "indexes",
          `${paperId}.sqlite3`,
        );
    if (!existsSync(indexPath))
      throw new Error("Document index has not been created.");
    const limit = clampNumber(params.limit, 1, 30, 10);
    const currentPage = Number(params.current_page) || undefined;
    const query = String(params.query ?? "").trim();
    if (!query) return [];
    return this.searchIndex(indexPath, query, limit, currentPage);
  }

  private async searchLibrary(
    params: Record<string, unknown>,
  ): Promise<SearchHit[]> {
    const paperIds = Array.isArray(params.paper_ids)
      ? [...new Set(params.paper_ids.map(String).filter(Boolean))].slice(
          0,
          1_000,
        )
      : [];
    const indexDir = String(params.index_dir ?? "");
    const limit = clampNumber(params.limit, 1, 80, 30);
    const perPaperLimit = clampNumber(params.per_paper_limit, 1, 10, 4);
    const query = String(params.query ?? "").trim();
    if (!query) return [];
    const hits: SearchHit[] = [];
    // 全库检索没有创建一个“全库总数据库”。这里逐篇打开
    // indexes/<paperId>.sqlite3，检索后再把各论文结果汇总。
    for (const paperId of paperIds) {
      const indexPath = join(indexDir, `${paperId}.sqlite3`);
      if (!existsSync(indexPath)) continue;
      const paperHits = await this.searchIndex(
        indexPath,
        query,
        perPaperLimit * 3,
        undefined,
      );
      hits.push(...paperHits.map((hit) => ({ ...hit, paper_id: paperId })));
    }
    return diversify(hits, limit, perPaperLimit);
  }

  private async searchIndex(
    indexPath: string,
    query: string,
    limit: number,
    currentPage?: number,
  ): Promise<SearchHit[]> {
    const database = new DatabaseSync(indexPath, { readOnly: true });
    try {
      // FTS5/BM25 负责精确词和前缀；轻量模糊匹配补充中文子串与少量拼写错误。
      // 两路结果只在本地文本上运行，不加载模型，也不需要额外运行时。
      const lexical = lexicalSearch(database, query, limit * 3);
      const fuzzy = fuzzySearch(database, query, limit * 3);
      return fuseRankings([lexical, fuzzy], limit, currentPage);
    } finally {
      database.close();
    }
  }

  private writeIndex(
    indexPath: string,
    chunks: Chunk[],
    source: IndexSource,
  ): void {
    const database = new DatabaseSync(indexPath);
    let transactionStarted = false;
    try {
      // 一个事务内删除旧表并写入新表：提交成功后，旧切片和旧 FTS
      // 会同时被 full.md 生成的新数据替换。
      database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      database.exec(`
        DROP TABLE IF EXISTS chunks_fts;
        DROP TABLE IF EXISTS chunks;
        DROP TABLE IF EXISTS index_metadata;
        CREATE TABLE chunks (
          chunk_id TEXT PRIMARY KEY,
          page INTEGER NOT NULL,
          text TEXT NOT NULL,
          bbox_json TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE chunks_fts USING fts5(
          chunk_id UNINDEXED,
          page UNINDEXED,
          text,
          tokenize = 'unicode61 remove_diacritics 2'
        );
        CREATE TABLE index_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      const insertChunk = database.prepare(
        "INSERT INTO chunks (chunk_id, page, text, bbox_json) VALUES (?, ?, ?, ?)",
      );
      const insertFts = database.prepare(
        "INSERT INTO chunks_fts (chunk_id, page, text) VALUES (?, ?, ?)",
      );
      const insertMetadata = database.prepare(
        "INSERT INTO index_metadata (key, value) VALUES (?, ?)",
      );
      for (const chunk of chunks) {
        insertChunk.run(
          chunk.chunkId,
          chunk.page,
          chunk.text,
          JSON.stringify(chunk.bbox),
        );
        insertFts.run(chunk.chunkId, chunk.page, chunk.text);
      }
      const metadata = new Map<string, string>([
        ["source_kind", source.kind],
        ["source_path", source.path],
        ["source_digest", source.digest ?? ""],
        ["search_profile", TEXT_SEARCH_PROFILE],
        ["indexed_at", new Date().toISOString()],
        ["page_count", String(new Set(chunks.map((chunk) => chunk.page)).size)],
        ["chunk_count", String(chunks.length)],
      ]);
      for (const [key, value] of metadata) {
        insertMetadata.run(key, value);
      }
      database.exec("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Preserve the original indexing error.
        }
      }
      throw error;
    } finally {
      database.close();
    }
  }

  private async extractReferenceDois(
    params: Record<string, unknown>,
  ): Promise<string[]> {
    const source = this.readReferenceText(params);
    const citations = extractNumberedReferenceCitations(source);
    const doiSource = citations.length > 0 ? citations.join("\n") : source;
    return [
      ...new Set(
        [...doiSource.matchAll(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi)].map(
          (match) => match[0].replace(/[.,;:)\]}]+$/, "").toLowerCase(),
        ),
      ),
    ].slice(0, 100);
  }

  private async extractReferenceCitations(
    params: Record<string, unknown>,
  ): Promise<string[]> {
    return extractNumberedReferenceCitations(this.readReferenceText(params));
  }

  private readReferenceText(params: Record<string, unknown>): string {
    const paperId = String(params.paper_id);
    const indexPath = join(
      String(params.index_dir ?? ""),
      `${paperId}.sqlite3`,
    );
    if (!existsSync(indexPath)) return "";
    const database = new DatabaseSync(indexPath, { readOnly: true });
    try {
      const rows = database
        .prepare("SELECT page, text FROM chunks ORDER BY page, chunk_id")
        .all() as Array<{ page: number; text: string }>;
      const maxPage = Math.max(...rows.map((row) => Number(row.page)), 0);
      const text = rows
        .filter(
          (row) => Number(row.page) >= Math.max(1, Math.floor(maxPage * 0.7)),
        )
        .map((row) => row.text)
        .join("\n");
      return text;
    } finally {
      database.close();
    }
  }

  private async readDocumentPages(
    params: Record<string, unknown>,
  ): Promise<DocumentPageText[]> {
    const pdfPath =
      typeof params.pdf_path === "string" ? params.pdf_path.trim() : "";
    if (pdfPath) {
      return this.readPdfPages(pdfPath);
    }
    const paperId = String(params.paper_id);
    const indexPath = join(
      String(params.index_dir ?? ""),
      `${paperId}.sqlite3`,
    );
    if (!existsSync(indexPath)) {
      throw new Error("Document index has not been created.");
    }
    const database = new DatabaseSync(indexPath, { readOnly: true });
    try {
      const rows = database
        .prepare(
          "SELECT rowid AS position, CAST(page AS INTEGER) AS page, text FROM chunks ORDER BY page, position",
        )
        .all() as Array<{ position: number; page: number; text: string }>;
      const byPage = new Map<number, string>();
      for (const row of rows) {
        const current = byPage.get(row.page) ?? "";
        byPage.set(row.page, mergeChunkText(current, row.text));
      }
      return [...byPage.entries()].map(([page, text]) => ({
        page,
        text: text.trim(),
      }));
    } finally {
      database.close();
    }
  }

  private async readPdfPages(pdfPath: string): Promise<DocumentPageText[]> {
    if (!existsSync(pdfPath)) throw new Error("PDF file does not exist.");
    const pdfjs = await loadPdfJs();
    const loadingTask = pdfjs.getDocument({
      url: pdfPath,
      standardFontDataUrl: toPdfJsDirectoryUrl(this.standardFontDirectory),
      wasmUrl: toPdfJsDirectoryUrl(this.wasmDirectory),
    });
    const document = await loadingTask.promise;
    const pages: DocumentPageText[] = [];
    try {
      for (let pageIndex = 0; pageIndex < document.numPages; pageIndex += 1) {
        const page = await document.getPage(pageIndex + 1);
        const textContent = await page.getTextContent();
        const items = textContent.items
          .filter((item) => "str" in item && typeof item.str === "string")
          .map((item) => item as PdfTextItem);
        const viewport = page.getViewport({ scale: 1 });
        pages.push({
          page: pageIndex + 1,
          text: reconstructPdfPageText(items, viewport.width).trim(),
        });
      }
    } finally {
      await loadingTask.destroy();
    }
    return pages.filter((page) => page.text);
  }
}

export function parseMarkdownPages(markdown: string): DocumentPageText[] {
  const normalized = markdown.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  // 支持 <!-- page: N -->、## 第 N 页和 ## Page N。
  // 页标记之前的标题、作者、DOI 等前置信息归入第一页，便于检索元数据。
  const preamble: string[] = [];
  const pages = new Map<number, string[]>();
  let currentPage: number | undefined;
  for (const line of normalized.split("\n")) {
    const page = markdownPageNumber(line);
    if (page !== undefined) {
      currentPage = page;
      if (!pages.has(page)) pages.set(page, []);
      continue;
    }
    if (currentPage === undefined) {
      preamble.push(line);
    } else {
      pages.get(currentPage)!.push(line);
    }
  }

  if (!pages.size) return [{ page: 1, text: normalized }];
  const orderedPageNumbers = [...pages.keys()].sort(
    (left, right) => left - right,
  );
  const firstPage = orderedPageNumbers[0];
  if (preamble.some((line) => line.trim())) {
    pages.set(firstPage, [...preamble, "", ...(pages.get(firstPage) ?? [])]);
  }
  return orderedPageNumbers.flatMap((page) => {
    const text = (pages.get(page) ?? []).join("\n").trim();
    return text ? [{ page, text }] : [];
  });
}

function markdownPageNumber(line: string): number | undefined {
  const comment = line.match(/^\s*<!--\s*page\s*:\s*(\d+)\s*-->\s*$/i);
  const chineseHeading = line.match(/^\s{0,3}#{1,6}\s*第\s*(\d+)\s*页\s*$/u);
  const englishHeading = line.match(/^\s{0,3}#{1,6}\s*page\s*(\d+)\s*$/i);
  const page = Number(
    comment?.[1] ?? chineseHeading?.[1] ?? englishHeading?.[1],
  );
  return Number.isInteger(page) && page > 0 ? page : undefined;
}

function readIndexSummary(indexPath: string):
  | {
      sourceKind?: string;
      sourceDigest?: string;
      pageCount: number;
      chunkCount: number;
    }
  | undefined {
  if (!existsSync(indexPath)) return undefined;
  const database = new DatabaseSync(indexPath, { readOnly: true });
  try {
    const hasMetadata = database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'index_metadata'",
      )
      .get() as { present?: number } | undefined;
    if (!hasMetadata?.present) return undefined;
    const metadataRows = database
      .prepare("SELECT key, value FROM index_metadata")
      .all() as Array<{ key: string; value: string }>;
    const metadata = new Map(metadataRows.map((row) => [row.key, row.value]));
    return {
      sourceKind: metadata.get("source_kind"),
      sourceDigest: metadata.get("source_digest"),
      pageCount: Number(metadata.get("page_count")) || 0,
      chunkCount: Number(metadata.get("chunk_count")) || 0,
    };
  } catch {
    return undefined;
  } finally {
    database.close();
  }
}

function toPdfJsDirectoryUrl(directory: string): string {
  return `${directory.replaceAll("\\", "/").replace(/\/+$/, "")}/`;
}

function splitChunks(paperId: string, page: number, text: string): Chunk[] {
  const clean = normalizePdfPageText(text);
  if (!clean) return [];
  const chunks: Chunk[] = [];
  let remaining = clean;
  // 相邻切片保留重叠文本，避免查询词恰好落在切片边界时丢失上下文。
  while (remaining) {
    const value = remaining.slice(0, MAX_CHUNK_CHARS);
    chunks.push({
      chunkId: `${paperId}:p${page}:c${chunks.length + 1}`,
      page,
      text: value,
      bbox: [0, 0, 0, 0],
    });
    if (remaining.length <= MAX_CHUNK_CHARS) break;
    remaining = remaining.slice(MAX_CHUNK_CHARS - CHUNK_OVERLAP_CHARS);
  }
  return chunks;
}

function lexicalSearch(
  database: DatabaseSync,
  query: string,
  limit: number,
): SearchHit[] {
  const tokens = [...new Set(extractSearchTerms(query))].slice(0, 18);
  if (!tokens.length) return [];
  const ftsQuery = tokens
    .map((token) => `"${token.replace(/"/g, '""')}"*`)
    .join(" OR ");
  try {
    // FTS5 的 bm25 越小越相关，因此取负数后统一为“分数越大越相关”。
    return database
      .prepare(
        `
      SELECT chunk_id, CAST(page AS INTEGER) AS page, text, -bm25(chunks_fts) AS score
      FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score DESC LIMIT ?
    `,
      )
      .all(ftsQuery, limit) as unknown as SearchHit[];
  } catch {
    return [];
  }
}

function fuzzySearch(
  database: DatabaseSync,
  query: string,
  limit: number,
): SearchHit[] {
  const rows = database
    .prepare("SELECT chunk_id, CAST(page AS INTEGER) AS page, text FROM chunks")
    .all() as unknown as SearchHit[];
  return rows
    .map((row) => ({
      chunk_id: row.chunk_id,
      page: row.page,
      text: row.text,
      score: fuzzyTextScore(row.text, query),
    }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function fuseRankings(
  rankings: SearchHit[][],
  limit: number,
  currentPage?: number,
): SearchHit[] {
  const fused = new Map<string, SearchHit>();
  // Reciprocal Rank Fusion：不直接比较 BM25 与模糊匹配的原始数值，
  // 而是按它们各自的排名累加 1 / (60 + rank)，量纲更稳定。
  for (const ranking of rankings) {
    ranking.forEach((hit, index) => {
      const current = fused.get(hit.chunk_id) ?? { ...hit, score: 0 };
      current.score += 1 / (60 + index + 1);
      fused.set(hit.chunk_id, current);
    });
  }
  if (currentPage) {
    for (const hit of fused.values()) {
      const distance = Math.abs(hit.page - currentPage);
      if (distance === 0) hit.score += 0.018;
      else if (distance === 1) hit.score += 0.008;
    }
  }
  return [...fused.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function diversify(
  hits: SearchHit[],
  limit: number,
  perPaperLimit: number,
): SearchHit[] {
  const count = new Map<string, number>();
  // 限制单篇论文最多占据 perPaperLimit 个结果，避免高频词让一篇论文刷满列表。
  return hits
    .sort((left, right) => right.score - left.score)
    .filter((hit) => {
      const paperId = hit.paper_id ?? "";
      const current = count.get(paperId) ?? 0;
      if (current >= perPaperLimit) return false;
      count.set(paperId, current + 1);
      return true;
    })
    .slice(0, limit);
}

function normalizeText(value: string): string {
  return value
    .replace(/\u00ad/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeChunkText(current: string, next: string): string {
  if (!current) return next;
  const maximum = Math.min(400, current.length, next.length);
  for (let overlap = maximum; overlap >= 20; overlap -= 1) {
    if (current.endsWith(next.slice(0, overlap))) {
      return `${current}${next.slice(overlap)}`;
    }
  }
  return `${current}\n${next}`;
}

function guessTitle(items: PdfTextItem[], text: string): string | undefined {
  const candidates = items
    .map((item) => ({
      text: normalizeText(item.str),
      size: Math.abs(item.transform[3] ?? 0),
    }))
    .filter((item) => item.text.length >= 12 && item.text.length <= 320)
    .sort(
      (left, right) =>
        right.size - left.size || right.text.length - left.text.length,
    );
  return candidates[0]?.text ?? text.split(/[.!?]\s/)[0]?.slice(0, 320);
}

function guessDoi(value: string): string | undefined {
  return value
    .match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i)?.[0]
    .replace(/[.,;:)\]}]+$/, "");
}

function guessYear(value: string): number | undefined {
  const match = value.match(/\b(?:19|20)\d{2}\b/);
  return match ? Number(match[0]) : undefined;
}

function guessJournal(value: string): string | undefined {
  return value
    .match(/\b([A-Z][A-Za-z .&-]{4,80})\s+(?:19|20)\d{2}\b/)?.[1]
    ?.trim();
}

export function fuzzyTextScore(text: string, query: string): number {
  const normalizedText = normalizeSearchText(text);
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedText || !normalizedQuery) return 0;

  const compactText = normalizedText.replaceAll(" ", "");
  const compactQuery = normalizedQuery.replaceAll(" ", "");
  if (compactText.includes(compactQuery)) {
    return 1 + Math.min(compactQuery.length / 100, 0.2);
  }

  const textTerms = extractSearchTerms(normalizedText);
  const queryUnits = extractSearchTerms(normalizedQuery).flatMap((term) =>
    isHanText(term) ? characterNgrams(term, 2) : [term],
  );
  if (!queryUnits.length) return 0;

  let similarity = 0;
  for (const unit of queryUnits) {
    if (isHanText(unit)) {
      similarity += compactText.includes(unit) ? 1 : 0;
      continue;
    }
    similarity += bestWordSimilarity(unit, textTerms);
  }

  const coverage = similarity / queryUnits.length;
  const minimumCoverage = queryUnits.length <= 2 ? 0.5 : 0.4;
  return coverage >= minimumCoverage ? coverage : 0;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function extractSearchTerms(value: string): string[] {
  return (
    normalizeSearchText(value).match(
      /\p{Script=Han}+|[\p{Letter}\p{Number}]+/gu,
    ) ?? []
  );
}

function isHanText(value: string): boolean {
  return /^\p{Script=Han}+$/u.test(value);
}

function characterNgrams(value: string, size: number): string[] {
  const characters = [...value];
  if (characters.length <= size) return [value];
  return characters
    .slice(0, characters.length - size + 1)
    .map((_, index) => characters.slice(index, index + size).join(""));
}

function bestWordSimilarity(query: string, candidates: string[]): number {
  let best = 0;
  for (const candidate of candidates) {
    if (isHanText(candidate)) continue;
    if (candidate.includes(query) || query.includes(candidate)) return 1;
    if (query.length < 4 || Math.abs(candidate.length - query.length) > 2) {
      continue;
    }
    const similarity =
      1 -
      levenshteinDistance(query, candidate) /
        Math.max(query.length, candidate.length);
    best = Math.max(best, similarity);
  }
  return best >= 0.68 ? best : 0;
}

function levenshteinDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function clampNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(minimum, Math.min(maximum, number))
    : fallback;
}
