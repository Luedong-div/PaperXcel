import {
  normalizeCitationDoi,
  type CitationWorkRecord,
} from "../shared/citationGraph";

const EUROPE_PMC_SEARCH_URL =
  "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const EUROPE_PMC_TIMEOUT_MS = 15_000;

interface EuropePmcPayload {
  resultList?: {
    result?: EuropePmcResult | EuropePmcResult[];
  };
}

interface EuropePmcResult {
  id?: string | number;
  source?: string;
  title?: string | null;
  authorString?: string | null;
  authorList?: {
    author?: EuropePmcAuthor | EuropePmcAuthor[];
  } | null;
  journalTitle?: string | null;
  pubYear?: string | number | null;
  abstractText?: string | null;
  doi?: string | null;
  pmid?: string | number | null;
  pmcid?: string | null;
  citedByCount?: string | number | null;
  keywordList?: {
    keyword?: string | string[];
  } | null;
  fullTextUrlList?: {
    fullTextUrl?: EuropePmcFullTextUrl | EuropePmcFullTextUrl[];
  } | null;
}

interface EuropePmcAuthor {
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  initials?: string | null;
}

interface EuropePmcFullTextUrl {
  url?: string | null;
  documentStyle?: string | null;
  site?: string | null;
}

export interface EuropePmcSearchOptions {
  page?: number;
  pageSize?: number;
}

export class EuropePmcClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async search(
    query: string,
    options: EuropePmcSearchOptions = {},
  ): Promise<CitationWorkRecord[]> {
    const normalizedQuery = query.replace(/\s+/g, " ").trim();
    if (!normalizedQuery) return [];

    const url = new URL(EUROPE_PMC_SEARCH_URL);
    url.searchParams.set("query", normalizedQuery.slice(0, 500));
    url.searchParams.set(
      "page",
      String(Math.max(1, Math.floor(options.page ?? 1))),
    );
    url.searchParams.set(
      "pageSize",
      String(Math.max(1, Math.min(100, Math.floor(options.pageSize ?? 100)))),
    );
    url.searchParams.set("resultType", "core");
    url.searchParams.set("format", "json");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EUROPE_PMC_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "PaperXcel/1.0",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Europe PMC 请求失败 (HTTP ${response.status})。`);
      }
      const payload = (await response.json()) as EuropePmcPayload;
      return asArray(payload.resultList?.result)
        .map(parseEuropePmcWork)
        .filter((work): work is CitationWorkRecord => Boolean(work));
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Europe PMC 请求超时。", { cause: error });
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parseEuropePmcWork(
  payload: EuropePmcResult,
): CitationWorkRecord | undefined {
  const title = normalizeText(payload.title);
  if (!title) return undefined;

  const doi = normalizeCitationDoi(payload.doi ?? undefined);
  const pmcid = normalizeText(payload.pmcid);
  const pmid = normalizeText(payload.pmid);
  const source = normalizeText(payload.source)?.toUpperCase();
  const externalId = normalizeText(payload.id);
  const identity = pmcid
    ? `europe-pmc:${pmcid}`
    : pmid
      ? `europe-pmc:MED:${pmid}`
      : externalId
        ? `europe-pmc:${source ? `${source}:` : ""}${externalId}`
        : doi
          ? `europe-pmc:${doi}`
          : `europe-pmc:${normalizeTitle(title)}`;

  const sourceUrl =
    (pmcid ? `https://europepmc.org/article/PMC/${pmcid}` : undefined) ??
    (pmid ? `https://europepmc.org/article/MED/${pmid}` : undefined) ??
    normalizeFullTextUrl(payload.fullTextUrlList?.fullTextUrl) ??
    (doi ? `https://doi.org/${doi}` : undefined);

  const authors = unique([
    ...asArray(payload.authorList?.author).map(formatAuthor),
    ...splitAuthorString(payload.authorString),
  ]);
  const keywords = unique(
    asArray(payload.keywordList?.keyword)
      .map((keyword) => normalizeText(keyword))
      .filter((keyword): keyword is string => Boolean(keyword)),
  );

  return {
    openAlexId: identity,
    doi,
    title,
    authors,
    journal: normalizeText(payload.journalTitle),
    year: parseYear(payload.pubYear),
    abstract: normalizeText(payload.abstractText),
    ...(keywords.length > 0 ? { keywords } : {}),
    citedByCount: parseNonNegativeNumber(payload.citedByCount),
    referencedOpenAlexIds: [],
    sourceUrl,
    metadataSources: ["europe-pmc"],
    matchStatus: doi ? "verified" : "probable",
    matchConfidence: doi ? 90 : 76,
  };
}

function formatAuthor(author: EuropePmcAuthor): string | undefined {
  const fullName = normalizeText(author.fullName);
  if (fullName) return fullName;
  const name = [author.firstName, author.lastName]
    .map(normalizeText)
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || normalizeText(author.initials);
}

function splitAuthorString(value?: string | null): string[] {
  if (!value) return [];
  return value
    .split(/,\s*(?=[A-Z][^,;]*\b(?:and|$))|;\s*/u)
    .map((author) => author.trim())
    .filter(Boolean);
}

function normalizeFullTextUrl(
  values?: EuropePmcFullTextUrl | EuropePmcFullTextUrl[],
): string | undefined {
  return asArray(values)
    .map((value) => value.url)
    .map(normalizeHttpUrl)
    .find((value): value is string => Boolean(value));
}

function normalizeHttpUrl(value?: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeText(value?: string | number | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || undefined;
}

function parseYear(value?: string | number | null): number | undefined {
  const match = String(value ?? "").match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return match ? Number(match[1]) : undefined;
}

function parseNonNegativeNumber(
  value?: string | number | null,
): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function asArray<T>(value?: T | T[] | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function unique(values: Array<string | undefined>): string[] {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}
