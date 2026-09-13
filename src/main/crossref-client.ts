import { normalizeCitationDoi } from "../shared/citationGraph";

const CROSSREF_BASE_URL = "https://api.crossref.org";
const CROSSREF_TIMEOUT_MS = 10_000;

interface CrossrefDateParts {
  "date-parts"?: Array<Array<number | undefined>>;
}

interface CrossrefWorkPayload {
  abstract?: string;
  "is-referenced-by-count"?: number;
  DOI?: string;
  title?: string[] | string;
  author?: Array<{
    given?: string;
    family?: string;
    name?: string;
  }>;
  "container-title"?: string[];
  issued?: CrossrefDateParts;
  published?: CrossrefDateParts;
  "published-print"?: CrossrefDateParts;
  "published-online"?: CrossrefDateParts;
  volume?: string;
  issue?: string;
  page?: string;
  ISSN?: string[];
  URL?: string;
  reference?: Array<{
    DOI?: string;
    doi?: string;
  }>;
}

interface CrossrefResponse {
  message?: CrossrefWorkPayload;
}

interface CrossrefSearchResponse {
  message?: {
    items?: CrossrefWorkPayload[];
  };
}

export interface CrossrefWorkRecord {
  abstract?: string;
  citedByCount?: number;
  doi?: string;
  title?: string;
  authors: string[];
  journal?: string;
  year?: number;
  volume?: string;
  issue?: string;
  pages?: string;
  issn: string[];
  sourceUrl?: string;
}

export class CrossrefClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async getWorksByDois(dois: string[]): Promise<CrossrefWorkRecord[]> {
    const normalized = [
      ...new Set(
        dois
          .map(normalizeCitationDoi)
          .filter((doi): doi is string => Boolean(doi)),
      ),
    ];
    const works: CrossrefWorkRecord[] = [];
    await mapWithConcurrency(normalized, 4, async (doi) => {
      const work = await this.getWorkByDoi(doi);
      if (work) works.push(work);
    });
    return works;
  }

  async getWorkByDoi(
    doi: string,
    signal?: AbortSignal,
    strict = false,
  ): Promise<CrossrefWorkRecord | undefined> {
    const normalizedDoi = normalizeCitationDoi(doi);
    if (!normalizedDoi) return undefined;
    const payload = await this.request<CrossrefResponse>(
      `${CROSSREF_BASE_URL}/works/${encodeURIComponent(normalizedDoi)}`,
      signal,
      strict,
    );
    return parseCrossrefWork(payload?.message);
  }

  async getReferenceDois(doi: string, strict = false): Promise<string[]> {
    const normalizedDoi = normalizeCitationDoi(doi);
    if (!normalizedDoi) return [];
    const payload = await this.request<CrossrefResponse>(
      `${CROSSREF_BASE_URL}/works/${encodeURIComponent(normalizedDoi)}`,
      undefined,
      strict,
    );
    return [
      ...new Set(
        (payload?.message?.reference ?? [])
          .map((reference) =>
            normalizeCitationDoi(reference.DOI ?? reference.doi),
          )
          .filter((referenceDoi): referenceDoi is string =>
            Boolean(referenceDoi),
          ),
      ),
    ];
  }

  async findWorksByBibliographic(
    citation: string,
    limit = 5,
    options: {
      offset?: number;
      yearFrom?: number;
      yearTo?: number;
      sort?: "relevance" | "newest" | "citations";
      signal?: AbortSignal;
      strict?: boolean;
    } = {},
  ): Promise<CrossrefWorkRecord[]> {
    const url = new URL(`${CROSSREF_BASE_URL}/works`);
    url.searchParams.set("query.bibliographic", citation.slice(0, 800));
    url.searchParams.set("rows", String(Math.max(1, Math.min(limit, 100))));
    if (options.offset) url.searchParams.set("offset", String(options.offset));
    const filters = [
      options.yearFrom && `from-pub-date:${options.yearFrom}-01-01`,
      options.yearTo && `until-pub-date:${options.yearTo}-12-31`,
    ].filter(Boolean);
    if (filters.length) url.searchParams.set("filter", filters.join(","));
    if (options.sort && options.sort !== "relevance") {
      url.searchParams.set(
        "sort",
        options.sort === "newest" ? "published" : "is-referenced-by-count",
      );
      url.searchParams.set("order", "desc");
    }
    const payload = await this.request<CrossrefSearchResponse>(
      url.toString(),
      options.signal,
      options.strict,
    );
    return (payload?.message?.items ?? [])
      .map(parseCrossrefWork)
      .filter((work): work is CrossrefWorkRecord => Boolean(work?.title));
  }

  private async request<T>(
    url: string,
    signal?: AbortSignal,
    strict = false,
  ): Promise<T | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CROSSREF_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "PaperXcel/0.1",
        },
        signal: signal
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal,
      });
      if (!response.ok) {
        if (strict)
          throw new Error(`Crossref 请求失败 (HTTP ${response.status})。`);
        return undefined;
      }
      return (await response.json()) as T;
    } catch (error) {
      signal?.throwIfAborted();
      if (strict) throw error;
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parseCrossrefWork(
  payload?: CrossrefWorkPayload,
): CrossrefWorkRecord | undefined {
  if (!payload) return undefined;
  const titleValues = Array.isArray(payload.title)
    ? payload.title
    : [payload.title];
  const title = titleValues
    .find((value) => typeof value === "string" && value.trim())
    ?.trim();
  const doi = normalizeCitationDoi(payload.DOI);
  const authors = (payload.author ?? [])
    .map((author) => {
      if (author.name?.trim()) return author.name.trim();
      return [author.given, author.family].filter(Boolean).join(" ").trim();
    })
    .filter(Boolean);
  const journal = payload["container-title"]
    ?.find((value) => value.trim())
    ?.trim();
  const year = firstCrossrefYear(
    payload["published-print"],
    payload.published,
    payload.issued,
    payload["published-online"],
  );
  return {
    abstract:
      payload.abstract
        ?.replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim() || undefined,
    citedByCount: payload["is-referenced-by-count"],
    doi,
    title,
    authors: [...new Set(authors)],
    journal,
    year,
    volume: payload.volume?.trim() || undefined,
    issue: payload.issue?.trim() || undefined,
    pages: payload.page?.trim() || undefined,
    issn: [...new Set((payload.ISSN ?? []).map((value) => value.trim()))],
    sourceUrl:
      payload.URL?.trim() || (doi ? `https://doi.org/${doi}` : undefined),
  };
}

function firstCrossrefYear(
  ...dates: Array<CrossrefDateParts | undefined>
): number | undefined {
  for (const date of dates) {
    const year = date?.["date-parts"]?.[0]?.[0];
    if (typeof year === "number" && year >= 1500 && year <= 2100) {
      return year;
    }
  }
  return undefined;
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  handler: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        await handler(values[index]);
      }
    },
  );
  await Promise.all(workers);
}
