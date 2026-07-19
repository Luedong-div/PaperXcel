import {
  normalizeCitationDoi,
  type CitationWorkRecord,
} from "../shared/citationGraph";
import { parseArxivAtomEntries } from "./doiSources";

const ARXIV_SEARCH_URL = "https://export.arxiv.org/api/query";
const ARXIV_TIMEOUT_MS = 20_000;

export interface ArxivSearchOptions {
  start?: number;
  maxResults?: number;
}

export class ArxivClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async search(
    query: string,
    options: ArxivSearchOptions = {},
  ): Promise<CitationWorkRecord[]> {
    const normalizedQuery = query.replace(/\s+/g, " ").trim();
    if (!normalizedQuery) return [];

    const url = new URL(ARXIV_SEARCH_URL);
    url.searchParams.set(
      "search_query",
      `all:"${escapeQuery(normalizedQuery)}"`,
    );
    url.searchParams.set(
      "start",
      String(Math.max(0, Math.floor(options.start ?? 0))),
    );
    url.searchParams.set(
      "max_results",
      String(Math.max(1, Math.min(100, Math.floor(options.maxResults ?? 100)))),
    );
    url.searchParams.set("sortBy", "submittedDate");
    url.searchParams.set("sortOrder", "descending");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ARXIV_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        headers: {
          Accept: "application/atom+xml, application/xml, text/xml",
          "User-Agent": "PaperXcel/1.0",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`arXiv 请求失败 (HTTP ${response.status})。`);
      }
      const atom = await response.text();
      return parseArxivAtomEntries(atom)
        .map(arxivLookupToCitationWork)
        .filter((work): work is CitationWorkRecord => Boolean(work));
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("arXiv 请求超时。", { cause: error });
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timeout);
    }
  }
}

function arxivLookupToCitationWork(
  result: ReturnType<typeof parseArxivAtomEntries>[number],
): CitationWorkRecord | undefined {
  const arxivId = result.metadata.arxivId?.trim();
  const title = result.metadata.title?.trim();
  if (!arxivId || !title) return undefined;
  const doi = normalizeCitationDoi(result.metadata.doi);
  return {
    openAlexId: `arxiv:${arxivId}`,
    doi,
    title,
    authors: [...result.metadata.authors],
    journal: result.metadata.journal,
    year: result.metadata.year,
    abstract: result.metadata.abstract,
    referencedOpenAlexIds: [],
    sourceUrl: result.metadata.sourceUrl,
    metadataSources: ["arxiv"],
    matchStatus: doi ? "verified" : "probable",
    matchConfidence: doi ? 88 : 74,
  };
}

function escapeQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
