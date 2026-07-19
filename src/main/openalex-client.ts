import {
  normalizeCitationDoi,
  normalizeOpenAlexId,
  type CitationWorkRecord,
} from "../shared/citationGraph";
import type {
  OpenAlexConfigInput,
  OpenAlexTestResult,
} from "../shared/contracts";

// OpenAlex 把每篇论文称为一个 Work。这里只请求图谱和详情面板需要的字段，
// 避免下载完整记录，减少网络传输与 JSON 解析开销。
const OPENALEX_BASE_URL = "https://api.openalex.org";
const OPENALEX_SELECT = [
  "id",
  "doi",
  "display_name",
  "title",
  "authorships",
  "publication_year",
  "cited_by_count",
  "referenced_works",
  "abstract_inverted_index",
  "keywords",
  "primary_location",
].join(",");

// 这里只描述 OpenAlex API 响应中实际会使用的部分，并非完整 Work 结构。
interface OpenAlexWorkPayload {
  id?: string;
  doi?: string | null;
  display_name?: string;
  title?: string;
  publication_year?: number | null;
  cited_by_count?: number;
  referenced_works?: string[];
  abstract_inverted_index?: Record<string, number[]> | null;
  keywords?: Array<{ display_name?: string } | string> | null;
  authorships?: Array<{
    author?: { display_name?: string };
  }>;
  primary_location?: {
    landing_page_url?: string | null;
    source?: { display_name?: string } | null;
  } | null;
}

interface OpenAlexListPayload {
  results?: OpenAlexWorkPayload[];
}

export interface OpenAlexSearchOptions {
  page?: number;
  sort?: "relevance" | "publication-date";
}

/**
 * 引文图谱使用的 OpenAlex 客户端。
 *
 * 主要查询方式有三种：
 * 1. DOI -> 单篇 OpenAlex Work；
 * 2. OpenAlex ID / DOI 列表 -> 批量 Work；
 * 3. cites:W... -> 查找引用指定论文的 Work。
 */
export class OpenAlexClient {
  constructor(
    private readonly apiKey = "",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  // DOI 是连接本地论文与 OpenAlex 记录的首选稳定标识符。
  async getWorkByDoi(doi: string): Promise<CitationWorkRecord | undefined> {
    const normalized = normalizeCitationDoi(doi);
    if (!normalized) return undefined;
    const url = new URL(
      `${OPENALEX_BASE_URL}/works/doi:${encodeURIComponent(normalized)}`,
    );
    url.searchParams.set("select", OPENALEX_SELECT);
    const payload = await this.request<OpenAlexWorkPayload>(url);
    return parseOpenAlexWork(payload);
  }

  // 参考文献关系返回 OpenAlex ID，再通过这些 ID 批量取得标题、作者和摘要。
  async getWorksByOpenAlexIds(ids: string[]): Promise<CitationWorkRecord[]> {
    const normalized = unique(
      ids.map(normalizeOpenAlexId).filter((id): id is string => Boolean(id)),
    );
    return this.getWorksByFilter("openalex_id", normalized);
  }

  // Crossref 或 PDF 参考文献解析得到 DOI 后，通过此方法换成 OpenAlex Work。
  async getWorksByDois(dois: string[]): Promise<CitationWorkRecord[]> {
    const normalized = unique(
      dois
        .map(normalizeCitationDoi)
        .filter((doi): doi is string => Boolean(doi)),
    );
    return this.getWorksByFilter("doi", normalized);
  }

  async findWorksBySearch(
    query: string,
    limit = 5,
    options: OpenAlexSearchOptions = {},
  ): Promise<CitationWorkRecord[]> {
    const normalized = query.replace(/\s+/g, " ").trim();
    if (!normalized) return [];
    const url = new URL(`${OPENALEX_BASE_URL}/works`);
    url.searchParams.set("search", normalized.slice(0, 800));
    url.searchParams.set("per_page", String(Math.max(1, Math.min(limit, 100))));
    if (options.page && Number.isFinite(options.page)) {
      url.searchParams.set(
        "page",
        String(Math.max(1, Math.floor(options.page))),
      );
    }
    if (options.sort === "publication-date") {
      url.searchParams.set("sort", "publication_date:desc");
    }
    url.searchParams.set("select", OPENALEX_SELECT);
    const payload = await this.request<OpenAlexListPayload>(url);
    return (payload.results ?? [])
      .map(parseOpenAlexWork)
      .filter((work): work is CitationWorkRecord => Boolean(work));
  }

  // OpenAlex 的 cites 过滤器用于反向查询“哪些论文引用了本文”。
  // 服务端按 cited_by_count 倒序，客户端只接收最常被引用的前 limit 篇。
  async getCitingWorks(
    openAlexId: string,
    limit: number,
  ): Promise<CitationWorkRecord[]> {
    const normalized = normalizeOpenAlexId(openAlexId);
    if (!normalized) return [];
    const url = new URL(`${OPENALEX_BASE_URL}/works`);
    url.searchParams.set("filter", `cites:${normalized}`);
    url.searchParams.set("sort", "cited_by_count:desc");
    url.searchParams.set("per_page", String(Math.max(1, Math.min(limit, 100))));
    url.searchParams.set("select", OPENALEX_SELECT);
    const payload = await this.request<OpenAlexListPayload>(url);
    return (payload.results ?? [])
      .map(parseOpenAlexWork)
      .filter((work): work is CitationWorkRecord => Boolean(work));
  }

  async test(): Promise<OpenAlexTestResult> {
    try {
      const url = new URL(`${OPENALEX_BASE_URL}/works/W2741809807`);
      url.searchParams.set("select", "id,display_name");
      await this.request<OpenAlexWorkPayload>(url);
      return { ok: true, detail: "OpenAlex 连接正常。" };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async getWorksByFilter(
    field: "openalex_id" | "doi",
    values: string[],
  ): Promise<CitationWorkRecord[]> {
    const works: CitationWorkRecord[] = [];
    // OR 过滤列表按 100 个标识符分批，避免请求 URL 过长。
    for (let index = 0; index < values.length; index += 100) {
      const chunk = values.slice(index, index + 100);
      if (!chunk.length) continue;
      const url = new URL(`${OPENALEX_BASE_URL}/works`);
      url.searchParams.set("filter", `${field}:${chunk.join("|")}`);
      url.searchParams.set("per_page", String(chunk.length));
      url.searchParams.set("select", OPENALEX_SELECT);
      const payload = await this.request<OpenAlexListPayload>(url);
      works.push(
        ...(payload.results ?? [])
          .map(parseOpenAlexWork)
          .filter((work): work is CitationWorkRecord => Boolean(work)),
      );
    }
    return works;
  }

  private async request<T>(url: URL): Promise<T> {
    if (this.apiKey) url.searchParams.set("api_key", this.apiKey);
    let lastError: Error | undefined;
    // 超时、限流和服务端错误最多重试三次；参数或鉴权错误直接抛出。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await this.fetchImpl(url, {
          headers: {
            Accept: "application/json",
            "User-Agent": "PaperXcel/0.1",
          },
          signal: controller.signal,
        });
        if (response.ok) return (await response.json()) as T;
        const detail = (await response.text()).slice(0, 240);
        const error = new Error(
          response.status === 401 || response.status === 403
            ? "OpenAlex API Key 无效或额度不足。"
            : response.status === 429
              ? "OpenAlex 请求过于频繁或今日额度已用尽。"
              : `OpenAlex 请求失败 (${response.status})${detail ? `：${detail}` : ""}`,
        );
        if (response.status !== 429 && response.status < 500) throw error;
        lastError = error;
      } catch (error) {
        lastError =
          error instanceof Error && error.name === "AbortError"
            ? new Error("OpenAlex 请求超时。")
            : error instanceof Error
              ? error
              : new Error(String(error));
      } finally {
        clearTimeout(timeout);
      }
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    throw lastError ?? new Error("OpenAlex 请求失败。");
  }
}

export function createOpenAlexClient(
  input: OpenAlexConfigInput & { apiKey?: string },
): OpenAlexClient {
  return new OpenAlexClient(input.apiKey?.trim() ?? "");
}

/**
 * 将 OpenAlex API 的 Work 转换为 PaperXcel 内部统一结构。
 *
 * OpenAlex 的 DOI 和 Work ID 通常是完整 URL，这里统一规范化成
 * `10.xxxx/...` 和 `W123...`，方便缓存、去重以及与本地论文匹配。
 */
export function parseOpenAlexWork(
  payload: OpenAlexWorkPayload,
): CitationWorkRecord | undefined {
  const openAlexId = normalizeOpenAlexId(payload.id);
  const title = (payload.display_name || payload.title || "").trim();
  if (!openAlexId || !title) return undefined;
  const doi = normalizeCitationDoi(payload.doi ?? undefined);
  const keywords = unique(
    (payload.keywords ?? [])
      .map((keyword) =>
        typeof keyword === "string" ? keyword : keyword.display_name,
      )
      .map((keyword) => keyword?.trim())
      .filter((keyword): keyword is string => Boolean(keyword)),
  );
  return {
    openAlexId,
    doi,
    title,
    authors: unique(
      (payload.authorships ?? [])
        .map((authorship) => authorship.author?.display_name?.trim())
        .filter((author): author is string => Boolean(author)),
    ),
    journal:
      payload.primary_location?.source?.display_name?.trim() || undefined,
    year:
      typeof payload.publication_year === "number"
        ? payload.publication_year
        : undefined,
    abstract: reconstructOpenAlexAbstract(payload.abstract_inverted_index),
    ...(keywords.length > 0 ? { keywords } : {}),
    citedByCount: Math.max(0, Number(payload.cited_by_count) || 0),
    referencedOpenAlexIds: unique(
      (payload.referenced_works ?? [])
        .map(normalizeOpenAlexId)
        .filter((id): id is string => Boolean(id)),
    ),
    sourceUrl:
      payload.primary_location?.landing_page_url?.trim() ||
      (doi ? `https://doi.org/${doi}` : `https://openalex.org/${openAlexId}`),
    metadataSources: ["openalex"],
    matchStatus: "verified",
    matchConfidence: 100,
  };
}

/**
 * OpenAlex 为节省空间，不直接返回摘要字符串，而是返回“倒排索引”：
 *
 * {
 *   "Quantum": [0, 8],
 *   "chemistry": [1]
 * }
 *
 * 数组中的数字是单词在原摘要里的位置。按位置重新排序即可恢复文本。
 */
export function reconstructOpenAlexAbstract(
  invertedIndex?: Record<string, number[]> | null,
): string | undefined {
  if (!invertedIndex) return undefined;
  const tokens = Object.entries(invertedIndex)
    .flatMap(([word, positions]) =>
      positions
        .filter((position) => Number.isInteger(position) && position >= 0)
        .map((position) => ({ position, word })),
    )
    .sort((left, right) => left.position - right.position);
  return (
    tokens
      .map((token) => token.word)
      .join(" ")
      .trim() || undefined
  );
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
