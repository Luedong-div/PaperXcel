import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import * as ort from "onnxruntime-node";
import { extractNumberedReferenceCitations } from "./reference-citations";

const MAX_CHUNK_CHARS = 1_600;
const CHUNK_OVERLAP_CHARS = 180;

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

type PdfTextItem = {
  str: string;
  transform: number[];
};

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
    if (method === "search") return this.search(params);
    if (method === "search_library") return this.searchLibrary(params);
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
        const pageText = normalizeText(items.map((item) => item.str).join(" "));
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
    this.writeIndex(join(indexDir, `${paperId}.sqlite3`), chunks, embeddings);
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
    return this.searchIndex(
      indexPath,
      String(params.query ?? ""),
      limit,
      currentPage,
    );
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
    const query = String(params.query ?? "");
    const hits: SearchHit[] = [];
    for (const paperId of paperIds) {
      const indexPath = join(indexDir, `${paperId}.sqlite3`);
      if (!existsSync(indexPath)) continue;
      const paperHits = await this.searchIndex(
        indexPath,
        query,
        perPaperLimit * 3,
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
      const lexical = lexicalSearch(database, query, limit * 3);
      const queryEmbedding = await this.embedText(query);
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
  ): void {
    const database = new DatabaseSync(indexPath);
    try {
      database.exec(`
        DROP TABLE IF EXISTS chunks;
        DROP TABLE IF EXISTS chunks_fts;
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
      `);
      const insertChunk = database.prepare(
        "INSERT INTO chunks (chunk_id, page, text, bbox_json, embedding) VALUES (?, ?, ?, ?, ?)",
      );
      const insertFts = database.prepare(
        "INSERT INTO chunks_fts (chunk_id, page, text) VALUES (?, ?, ?)",
      );
      database.exec("BEGIN");
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
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
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

  private async embedChunks(
    chunks: Chunk[],
  ): Promise<Array<Float32Array | undefined>> {
    const embedderReady = await this.ensureEmbedder();
    if (!embedderReady) return chunks.map(() => undefined);
    return Promise.all(chunks.map((chunk) => this.embedText(chunk.text)));
  }

  private async embedText(text: string): Promise<Float32Array | undefined> {
    if (!(await this.ensureEmbedder()) || !this.tokenizer || !this.session)
      return undefined;
    try {
      const encoding = this.tokenizer.encode(text.slice(0, 8_000), {
        return_token_type_ids: true,
      });
      const length = encoding.ids.length;
      const feeds = {
        input_ids: new ort.Tensor(
          "int64",
          BigInt64Array.from(encoding.ids, BigInt),
          [1, length],
        ),
        attention_mask: new ort.Tensor(
          "int64",
          BigInt64Array.from(encoding.attention_mask, BigInt),
          [1, length],
        ),
        token_type_ids: new ort.Tensor(
          "int64",
          BigInt64Array.from(encoding.token_type_ids, BigInt),
          [1, length],
        ),
      };
      const output = await this.session.run(feeds);
      const values = output.last_hidden_state.data as Float32Array;
      const embedding = new Float32Array(512);
      let count = 0;
      for (let token = 0; token < length; token += 1) {
        if (!encoding.attention_mask[token]) continue;
        count += 1;
        const offset = token * 512;
        for (let dimension = 0; dimension < 512; dimension += 1) {
          embedding[dimension] += values[offset + dimension];
        }
      }
      let norm = 0;
      for (let index = 0; index < embedding.length; index += 1) {
        embedding[index] /= Math.max(count, 1);
        norm += embedding[index] ** 2;
      }
      norm = Math.sqrt(norm) || 1;
      for (let index = 0; index < embedding.length; index += 1)
        embedding[index] /= norm;
      return embedding;
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

function toPdfJsDirectoryUrl(directory: string): string {
  return `${directory.replaceAll("\\", "/").replace(/\/+$/, "")}/`;
}

function splitChunks(paperId: string, page: number, text: string): Chunk[] {
  const clean = normalizeText(text);
  if (!clean) return [];
  const chunks: Chunk[] = [];
  let remaining = clean;
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
