import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import * as ort from "onnxruntime-node";
import type { DocumentPageText } from "../shared/contracts";
import {
  normalizePdfPageText,
  reconstructPdfPageText,
  type PdfLayoutTextItem,
} from "./pdf-layout";
import { extractNumberedReferenceCitations } from "./reference-citations";

const MAX_CHUNK_CHARS = 1_600;
const CHUNK_OVERLAP_CHARS = 180;
const MAX_EMBEDDING_TOKENS = 512;
const EMBEDDING_DIMENSIONS = 512;
export const CURRENT_EMBEDDING_PROFILE =
  "bge-small-zh-v1.5-cls-query-instruction-v1";
export const LEGACY_EMBEDDING_PROFILE = "bge-small-zh-v1.5-mean-v0";
const BGE_QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章：";

export type EmbeddingProfile =
  | typeof CURRENT_EMBEDDING_PROFILE
  | typeof LEGACY_EMBEDDING_PROFILE;
export type EmbeddingRole = "document" | "query";
type QueryEmbeddingCache = Map<
  EmbeddingProfile,
  Promise<Float32Array | undefined>
>;

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
  semantic_ready: boolean;
}

interface MarkdownReindexResult {
  page_count: number;
  chunk_count: number;
  semantic_ready: boolean;
  updated: boolean;
}

interface IndexSource {
  kind: "pdf" | "markdown";
  path: string;
  digest?: string;
}

type PdfTextItem = PdfLayoutTextItem;

export class DocumentEngine {
  private tokenizer?: Tokenizer;
  private session?: ort.InferenceSession;
  private embeddingError?: string;

  constructor(
    private readonly modelDirectory: string,
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
    semanticSearch: boolean;
    detail?: string;
  }> {
    await this.ensureEmbedder();
    return {
      available: true,
      node: process.version,
      pdfjs: true,
      semanticSearch: Boolean(this.session && this.tokenizer),
      detail: this.embeddingError,
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

    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
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
    const embeddings = await this.embedChunks(chunks);
    const semanticReady = embeddings.some(
      (embedding) => embedding !== undefined,
    );
    if (semanticReady) {
      this.sendProgress({
        paper_id: paperId,
        stage: "Creating semantic index",
        progress: 88,
      });
    }
    this.writeIndex(join(indexDir, `${paperId}.sqlite3`), chunks, embeddings, {
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
      semantic_ready: semanticReady,
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
    // 与 PDF 索引相同的切片和 embedding 流程，最终覆盖该论文原来的 SQLite。
    const markdown = await readFile(markdownPath, "utf8");
    const pages = parseMarkdownPages(markdown);
    const chunks = pages.flatMap((page) =>
      splitChunks(paperId, page.page, page.text),
    );
    if (!chunks.length) {
      throw new Error("Markdown 文件中没有可索引的文本。请检查 markdown 文件.");
    }

    const indexPath = join(indexDir, `${paperId}.sqlite3`);
    // source_digest 用来判断 full.md 是否真的变化，避免每次启动都重新计算向量。
    const digest = createHash("sha256").update(markdown).digest("hex");
    const current = readIndexSummary(indexPath);
    if (
      !params.force &&
      current?.sourceKind === "markdown" &&
      current.sourceDigest === digest &&
      current.embeddingProfile === CURRENT_EMBEDDING_PROFILE
    ) {
      return {
        page_count: current.pageCount,
        chunk_count: current.chunkCount,
        semantic_ready: current.semanticReady,
        updated: false,
      };
    }

    const embeddings = await this.embedChunks(chunks);
    const semanticReady = embeddings.some(
      (embedding) => embedding !== undefined,
    );
    this.writeIndex(indexPath, chunks, embeddings, {
      kind: "markdown",
      path: markdownPath,
      digest,
    });
    return {
      page_count: pages.length,
      chunk_count: chunks.length,
      semantic_ready: semanticReady,
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
    const queryEmbeddings: QueryEmbeddingCache = new Map();
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
        queryEmbeddings,
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
    queryEmbeddings: QueryEmbeddingCache = new Map(),
  ): Promise<SearchHit[]> {
    const database = new DatabaseSync(indexPath, { readOnly: true });
    try {
      // lexical 使用 SQLite FTS5/BM25；semantic 使用 BGE query embedding
      // 与 chunks.embedding 做余弦相似度。最后用排名融合得到统一分数。
      const lexical = lexicalSearch(database, query, limit * 3);
      const embeddingProfile = readIndexEmbeddingProfile(database);
      const queryEmbedding = embeddingProfile
        ? await this.queryEmbedding(query, embeddingProfile, queryEmbeddings)
        : undefined;
      const semantic = queryEmbedding
        ? semanticSearch(database, queryEmbedding, limit * 3)
        : [];
      return fuseRankings([lexical, semantic], limit, currentPage);
    } finally {
      database.close();
    }
  }

  private writeIndex(
    indexPath: string,
    chunks: Chunk[],
    embeddings: Array<Float32Array | undefined>,
    source: IndexSource,
  ): void {
    const database = new DatabaseSync(indexPath);
    let transactionStarted = false;
    try {
      // 一个事务内删除旧表并写入新表：提交成功后，旧切片、旧 FTS
      // 和旧向量会同时被 full.md 生成的新数据替换。
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
          bbox_json TEXT NOT NULL,
          embedding BLOB
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
        "INSERT INTO chunks (chunk_id, page, text, bbox_json, embedding) VALUES (?, ?, ?, ?, ?)",
      );
      const insertFts = database.prepare(
        "INSERT INTO chunks_fts (chunk_id, page, text) VALUES (?, ?, ?)",
      );
      const insertMetadata = database.prepare(
        "INSERT INTO index_metadata (key, value) VALUES (?, ?)",
      );
      for (const [index, chunk] of chunks.entries()) {
        const embedding = embeddings[index];
        insertChunk.run(
          chunk.chunkId,
          chunk.page,
          chunk.text,
          JSON.stringify(chunk.bbox),
          embedding ? Buffer.from(embedding.buffer) : null,
        );
        insertFts.run(chunk.chunkId, chunk.page, chunk.text);
      }
      const metadata = new Map<string, string>([
        ["source_kind", source.kind],
        ["source_path", source.path],
        ["source_digest", source.digest ?? ""],
        ["embedding_profile", CURRENT_EMBEDDING_PROFILE],
        ["indexed_at", new Date().toISOString()],
        ["page_count", String(new Set(chunks.map((chunk) => chunk.page)).size)],
        ["chunk_count", String(chunks.length)],
        [
          "semantic_ready",
          embeddings.some((embedding) => embedding !== undefined)
            ? "true"
            : "false",
        ],
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
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
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

  private async embedChunks(
    chunks: Chunk[],
  ): Promise<Array<Float32Array | undefined>> {
    const embedderReady = await this.ensureEmbedder();
    if (!embedderReady) return chunks.map(() => undefined);
    return Promise.all(
      chunks.map((chunk) =>
        this.embedText(
          prepareEmbeddingText(chunk.text, "document"),
          CURRENT_EMBEDDING_PROFILE,
        ),
      ),
    );
  }

  private queryEmbedding(
    query: string,
    profile: EmbeddingProfile,
    cache: QueryEmbeddingCache,
  ): Promise<Float32Array | undefined> {
    const cached = cache.get(profile);
    if (cached) return cached;
    // 全库检索会逐篇读取 SQLite，但同一条 query 不应为每篇论文重复跑 ONNX。
    // 以 embedding profile 为键缓存 Promise，混合新旧索引时也最多只调用两次。
    const pending = this.embedText(
      prepareEmbeddingText(query, "query", profile),
      profile,
    );
    cache.set(profile, pending);
    return pending;
  }

  private async embedText(
    text: string,
    profile: EmbeddingProfile,
  ): Promise<Float32Array | undefined> {
    if (!(await this.ensureEmbedder()) || !this.tokenizer || !this.session)
      return undefined;
    try {
      const encoding = this.tokenizer.encode(text.slice(0, 8_000), {
        return_token_type_ids: true,
      });
      const inputIds = encoding.ids.slice(0, MAX_EMBEDDING_TOKENS);
      const attentionMask = encoding.attention_mask.slice(
        0,
        MAX_EMBEDDING_TOKENS,
      );
      const tokenTypeIds = encoding.token_type_ids.slice(
        0,
        MAX_EMBEDDING_TOKENS,
      );
      const length = inputIds.length;
      if (!length) return undefined;
      const feeds = {
        input_ids: new ort.Tensor(
          "int64",
          BigInt64Array.from(inputIds, BigInt),
          [1, length],
        ),
        attention_mask: new ort.Tensor(
          "int64",
          BigInt64Array.from(attentionMask, BigInt),
          [1, length],
        ),
        token_type_ids: new ort.Tensor(
          "int64",
          BigInt64Array.from(
            tokenTypeIds.length === length
              ? tokenTypeIds
              : new Array<number>(length).fill(0),
            BigInt,
          ),
          [1, length],
        ),
      };
      const output = await this.session.run(feeds);
      const values = output.last_hidden_state.data as Float32Array;
      return poolEmbedding(values, attentionMask, length, profile);
    } catch (error) {
      this.embeddingError =
        error instanceof Error ? error.message : String(error);
      return undefined;
    }
  }

  private async ensureEmbedder(): Promise<boolean> {
    if (this.tokenizer && this.session) return true;
    if (this.embeddingError) return false;
    try {
      const [tokenizerJson, tokenizerConfig] = await Promise.all([
        readFile(join(this.modelDirectory, "tokenizer.json"), "utf8"),
        readFile(join(this.modelDirectory, "tokenizer_config.json"), "utf8"),
      ]);
      this.tokenizer = new Tokenizer(
        JSON.parse(tokenizerJson),
        JSON.parse(tokenizerConfig),
      );
      this.session = await ort.InferenceSession.create(
        join(this.modelDirectory, "model_optimized.onnx"),
        { executionProviders: ["cpu"] },
      );
      return true;
    } catch (error) {
      this.embeddingError =
        error instanceof Error ? error.message : String(error);
      return false;
    }
  }
}

export function prepareEmbeddingText(
  text: string,
  role: EmbeddingRole,
  profile: EmbeddingProfile = CURRENT_EMBEDDING_PROFILE,
): string {
  const normalized = text.trim();
  if (role !== "query" || profile === LEGACY_EMBEDDING_PROFILE) {
    return normalized;
  }
  // BGE 的检索 instruction 只加在 query 上；文档向量保持原文，
  // 否则两侧都加提示会改变模型训练时约定的检索空间。
  return `${BGE_QUERY_INSTRUCTION}${normalized}`;
}

export function poolEmbedding(
  values: Float32Array,
  attentionMask: number[],
  tokenCount: number,
  profile: EmbeddingProfile = CURRENT_EMBEDDING_PROFILE,
): Float32Array {
  if (tokenCount < 1 || values.length < tokenCount * EMBEDDING_DIMENSIONS) {
    throw new Error("Embedding model returned an invalid hidden state.");
  }

  const embedding = new Float32Array(EMBEDDING_DIMENSIONS);
  if (profile === CURRENT_EMBEDDING_PROFILE) {
    // BGE 官方用最后一层的 [CLS] token 作为句向量，再进行 L2 normalize。
    embedding.set(values.subarray(0, EMBEDDING_DIMENSIONS));
  } else {
    // 旧版 PaperXcel 使用 attention-mask mean pooling。保留该分支只为读取
    // 已经落盘的旧向量；新索引统一写入带版本标记的 CLS 向量。
    let includedTokens = 0;
    for (let token = 0; token < tokenCount; token += 1) {
      if (!attentionMask[token]) continue;
      includedTokens += 1;
      const offset = token * EMBEDDING_DIMENSIONS;
      for (
        let dimension = 0;
        dimension < EMBEDDING_DIMENSIONS;
        dimension += 1
      ) {
        embedding[dimension] += values[offset + dimension];
      }
    }
    const divisor = Math.max(includedTokens, 1);
    for (let index = 0; index < embedding.length; index += 1) {
      embedding[index] /= divisor;
    }
  }

  let norm = 0;
  for (const value of embedding) norm += value ** 2;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < embedding.length; index += 1) {
    embedding[index] /= norm;
  }
  return embedding;
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

function readIndexEmbeddingProfile(
  database: DatabaseSync,
): EmbeddingProfile | undefined {
  try {
    const row = database
      .prepare("SELECT value FROM index_metadata WHERE key = ?")
      .get("embedding_profile") as { value?: string } | undefined;
    if (!row?.value) return LEGACY_EMBEDDING_PROFILE;
    if (
      row.value === CURRENT_EMBEDDING_PROFILE ||
      row.value === LEGACY_EMBEDDING_PROFILE
    ) {
      return row.value;
    }
    // 显式标记但当前代码不认识的版本不能猜测 pooling 方式，否则会混算向量。
    return undefined;
  } catch {
    // embedding_profile 引入前的索引没有该元数据，均由旧 mean pooling 生成。
    return LEGACY_EMBEDDING_PROFILE;
  }
}

function readIndexSummary(indexPath: string):
  | {
      sourceKind?: string;
      sourceDigest?: string;
      embeddingProfile?: string;
      pageCount: number;
      chunkCount: number;
      semanticReady: boolean;
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
      embeddingProfile: metadata.get("embedding_profile"),
      pageCount: Number(metadata.get("page_count")) || 0,
      chunkCount: Number(metadata.get("chunk_count")) || 0,
      semanticReady: metadata.get("semantic_ready") === "true",
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
  // 相邻切片保留重叠文本，避免查询关键词或语义恰好落在切片边界时丢失上下文。
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
  const tokens = [...new Set(query.match(/[\w\u4e00-\u9fff]+/gu) ?? [])]
    .filter((token) => token.length >= 2)
    .slice(0, 18);
  if (!tokens.length) return [];
  const ftsQuery = tokens
    .map((token) => `"${token.replace(/"/g, '""')}"`)
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

function semanticSearch(
  database: DatabaseSync,
  query: Float32Array,
  limit: number,
): SearchHit[] {
  const rows = database
    .prepare(
      "SELECT chunk_id, CAST(page AS INTEGER) AS page, text, embedding FROM chunks WHERE embedding IS NOT NULL",
    )
    .all() as unknown as Array<SearchHit & { embedding: Uint8Array }>;
  // embedding 在 SQLite 中以 Float32Array 的原始 BLOB 保存，读取后恢复为
  // 512 维向量，与当前查询向量计算 cosine similarity。
  return rows
    .map((row) => ({
      chunk_id: row.chunk_id,
      page: row.page,
      text: row.text,
      score: cosine(
        query,
        new Float32Array(
          row.embedding.buffer,
          row.embedding.byteOffset,
          row.embedding.byteLength / 4,
        ),
      ),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function fuseRankings(
  rankings: SearchHit[][],
  limit: number,
  currentPage?: number,
): SearchHit[] {
  const fused = new Map<string, SearchHit>();
  // Reciprocal Rank Fusion：不直接比较 BM25 与 cosine 的原始数值，
  // 而是按它们各自的排名累加 1 / (60 + rank)，量纲更稳定。
  for (const ranking of rankings) {
    ranking.forEach((hit, index) => {
      const current = fused.get(hit.chunk_id) ?? { ...hit, score: 0 };
      current.score += 1 / (60 + index + 1);
      if (currentPage) {
        const distance = Math.abs(hit.page - currentPage);
        if (distance === 0) current.score += 0.018;
        else if (distance === 1) current.score += 0.008;
      }
      fused.set(hit.chunk_id, current);
    });
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

function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return dot / ((Math.sqrt(leftNorm) || 1) * (Math.sqrt(rightNorm) || 1));
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
