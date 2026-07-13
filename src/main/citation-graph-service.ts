import { createHash } from "node:crypto";
import {
  CITATION_GRAPH_CITING_LIMIT,
  CITATION_GRAPH_CORE_VERSION,
  buildCitationGraphSnapshot,
  isCitationRecordFresh,
  normalizeCitationDoi,
  type CitationGraphCache,
  type CitationWorkRecord,
} from "../shared/citationGraph";
import type { CitationGraphRefreshResult, Paper } from "../shared/contracts";
import { OpenAlexClient } from "./openalex-client";

const CROSSREF_MATCH_CONCURRENCY = 4;
const CROSSREF_MATCH_MIN_SCORE = 35;
const CROSSREF_BASE_URL = "https://api.crossref.org";
const CROSSREF_TIMEOUT_MS = 10_000;
const CITATION_MATCH_THRESHOLD = 8;

interface CrossrefWorkPayload {
  message?: {
    reference?: Array<{
      DOI?: string;
      doi?: string;
    }>;
    items?: Array<{
      DOI?: string;
      score?: number;
    }>;
  };
}

export interface CitationGraphRefreshOptions {
  papers: Paper[];
  cache: CitationGraphCache;
  client: OpenAlexClient;
  force?: boolean;
  extractLocalReferenceDois?: (paper: Paper) => Promise<string[]>;
  extractLocalReferenceCitations?: (paper: Paper) => Promise<string[]>;
  fetchImpl?: typeof fetch;
  now?: Date;
}

export async function refreshCitationGraphData({
  papers,
  cache,
  client,
  force = false,
  extractLocalReferenceDois,
  extractLocalReferenceCitations,
  fetchImpl = fetch,
  now = new Date(),
}: CitationGraphRefreshOptions): Promise<{
  cache: CitationGraphCache;
  result: CitationGraphRefreshResult;
}> {
  const nextCache = cloneCache(cache);
  const errors: string[] = [];
  let updatedPapers = 0;
  let skippedPapers = 0;
  let failedPapers = 0;
  const libraryDois = new Set(
    papers
      .map((paper) => normalizeCitationDoi(paper.doi))
      .filter((doi): doi is string => Boolean(doi)),
  );

  await mapWithConcurrency(papers, 3, async (paper) => {
    const previous = nextCache.cores[paper.id];
    if (!force && isCitationRecordFresh(previous, now.getTime())) {
      skippedPapers += 1;
      return;
    }
    try {
      const core = paper.doi
        ? await refreshDoiPaper(
            paper,
            nextCache,
            client,
            libraryDois,
            extractLocalReferenceCitations,
            fetchImpl,
            now,
          )
        : await refreshLocalPaper(
            paper,
            nextCache,
            client,
            extractLocalReferenceDois,
            extractLocalReferenceCitations,
            now,
          );
      nextCache.cores[paper.id] = core;
      updatedPapers += 1;
    } catch (error) {
      failedPapers += 1;
      errors.push(
        `${paper.title}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  if (updatedPapers > 0) nextCache.updatedAt = now.toISOString();
  const snapshot = buildCitationGraphSnapshot(papers, nextCache, errors);
  return {
    cache: nextCache,
    result: {
      snapshot,
      updatedPapers,
      skippedPapers,
      failedPapers,
    },
  };
}

async function refreshDoiPaper(
  paper: Paper,
  cache: CitationGraphCache,
  client: OpenAlexClient,
  libraryDois: Set<string>,
  extractLocalReferenceCitations: CitationGraphRefreshOptions["extractLocalReferenceCitations"],
  fetchImpl: typeof fetch,
  now: Date,
) {
  const work = await client.getWorkByDoi(paper.doi!);
  if (!work) throw new Error("OpenAlex 未找到该 DOI。");
  cache.works[work.openAlexId] = work;

  const citations = extractLocalReferenceCitations
    ? await extractLocalReferenceCitations(paper).catch(() => [])
    : [];
  let referencedWorks = await client.getWorksByOpenAlexIds(
    work.referencedOpenAlexIds,
  );
  if (referencedWorks.length === 0) {
    const crossrefDois = await fetchCrossrefReferenceDois(
      paper.doi!,
      fetchImpl,
    );
    if (crossrefDois.length > 0) {
      referencedWorks = await client.getWorksByDois(crossrefDois);
    }
  }
  if (referencedWorks.length === 0 && citations.length > 0) {
    const citationDois = await resolveCrossrefCitationDois(
      citations,
      paper.doi!,
      fetchImpl,
    );
    if (citationDois.length > 0) {
      referencedWorks = await client.getWorksByDois(citationDois);
    }
  }
  const selectedReferences =
    citations.length > 0 && citations.length >= referencedWorks.length
      ? reconcileReferenceWorks(paper.id, citations, referencedWorks)
      : selectRelatedWorks(referencedWorks, undefined, libraryDois);
  storeWorks(cache, selectedReferences);
  const citingWorks = await client.getCitingWorks(
    work.openAlexId,
    CITATION_GRAPH_CITING_LIMIT,
  );
  storeWorks(cache, citingWorks);
  const selectedCitingWorks = selectRelatedWorks(
    citingWorks,
    CITATION_GRAPH_CITING_LIMIT,
  );

  return {
    version: CITATION_GRAPH_CORE_VERSION,
    paperId: paper.id,
    openAlexId: work.openAlexId,
    referencedOpenAlexIds: selectedReferences.map((item) => item.openAlexId),
    citingOpenAlexIds: selectedCitingWorks.map((item) => item.openAlexId),
    fetchedAt: now.toISOString(),
  };
}

async function fetchCrossrefReferenceDois(
  doi: string,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const normalizedDoi = normalizeCitationDoi(doi);
  if (!normalizedDoi) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CROSSREF_TIMEOUT_MS);
  try {
    const response = await fetchImpl(
      `${CROSSREF_BASE_URL}/works/${encodeURIComponent(normalizedDoi)}`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "PaperXcel/0.1",
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) return [];
    const payload = (await response.json()) as CrossrefWorkPayload;
    const dois = (payload.message?.reference ?? [])
      .map((reference) => normalizeCitationDoi(reference.DOI ?? reference.doi))
      .filter((referenceDoi): referenceDoi is string => Boolean(referenceDoi));
    return [...new Set(dois)];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveCrossrefCitationDois(
  citations: string[],
  sourceDoi: string,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const normalizedSourceDoi = normalizeCitationDoi(sourceDoi);
  const resolved = new Set<string>();
  const unmatched: string[] = [];
  for (const citation of citations) {
    const directDoi = normalizeCitationDoi(
      citation.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i)?.[0],
    );
    if (directDoi && directDoi !== normalizedSourceDoi) resolved.add(directDoi);
    else if (citation.trim()) unmatched.push(citation.trim());
  }

  for (
    let index = 0;
    index < unmatched.length;
    index += CROSSREF_MATCH_CONCURRENCY
  ) {
    const chunk = unmatched.slice(index, index + CROSSREF_MATCH_CONCURRENCY);
    const matches = await Promise.all(
      chunk.map((citation) =>
        fetchCrossrefBibliographicDoi(citation, fetchImpl),
      ),
    );
    for (const doi of matches) {
      if (doi && doi !== normalizedSourceDoi) resolved.add(doi);
    }
  }
  return [...resolved];
}

async function fetchCrossrefBibliographicDoi(
  citation: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  const url = new URL(`${CROSSREF_BASE_URL}/works`);
  url.searchParams.set("query.bibliographic", citation.slice(0, 800));
  url.searchParams.set("rows", "1");
  url.searchParams.set("select", "DOI,score");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CROSSREF_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "PaperXcel/0.1",
      },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as CrossrefWorkPayload;
    const match = payload.message?.items?.[0];
    if ((match?.score ?? 0) < CROSSREF_MATCH_MIN_SCORE) return undefined;
    return normalizeCitationDoi(match?.DOI);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshLocalPaper(
  paper: Paper,
  cache: CitationGraphCache,
  client: OpenAlexClient,
  extractLocalReferenceDois: CitationGraphRefreshOptions["extractLocalReferenceDois"],
  extractLocalReferenceCitations: CitationGraphRefreshOptions["extractLocalReferenceCitations"],
  now: Date,
) {
  const dois = extractLocalReferenceDois
    ? await extractLocalReferenceDois(paper)
    : [];
  const works = await client.getWorksByDois(
    dois.map(normalizeCitationDoi).filter((doi): doi is string => Boolean(doi)),
  );
  const citations = extractLocalReferenceCitations
    ? await extractLocalReferenceCitations(paper).catch(() => [])
    : [];
  const selectedReferences =
    citations.length > 0 && citations.length >= works.length
      ? reconcileReferenceWorks(paper.id, citations, works)
      : selectRelatedWorks(works);
  storeWorks(cache, selectedReferences);
  return {
    version: CITATION_GRAPH_CORE_VERSION,
    paperId: paper.id,
    referencedOpenAlexIds: selectedReferences.map((item) => item.openAlexId),
    citingOpenAlexIds: [],
    fetchedAt: now.toISOString(),
  };
}

function selectRelatedWorks(
  works: CitationWorkRecord[],
  limit?: number,
  preferredDois = new Set<string>(),
): CitationWorkRecord[] {
  const preferred = works.filter(
    (work) => work.doi && preferredDois.has(work.doi),
  );
  const ranked = [...works].sort(
    (first, second) =>
      second.citedByCount - first.citedByCount ||
      (second.year ?? 0) - (first.year ?? 0) ||
      first.title.localeCompare(second.title),
  );
  const selected = new Map<string, CitationWorkRecord>();
  for (const work of [...preferred, ...ranked]) {
    selected.set(work.openAlexId, work);
    if (limit !== undefined && selected.size >= limit) break;
  }
  return [...selected.values()];
}

function reconcileReferenceWorks(
  paperId: string,
  citations: string[],
  works: CitationWorkRecord[],
): CitationWorkRecord[] {
  const available = new Map(works.map((work) => [work.openAlexId, work]));
  return citations.map((citation, index) => {
    const directDoi = extractCitationDoi(citation);
    let matchedWork = directDoi
      ? [...available.values()].find(
          (work) => normalizeCitationDoi(work.doi) === directDoi,
        )
      : undefined;
    if (!matchedWork) {
      const bestMatch = [...available.values()]
        .map((work) => ({
          work,
          score: citationWorkMatchScore(citation, work),
        }))
        .sort((first, second) => second.score - first.score)[0];
      if (bestMatch?.score >= CITATION_MATCH_THRESHOLD) {
        matchedWork = bestMatch.work;
      }
    }
    if (matchedWork) {
      available.delete(matchedWork.openAlexId);
      return matchedWork;
    }
    return createCitationPlaceholderWork(paperId, index, citation);
  });
}

function citationWorkMatchScore(
  citation: string,
  work: CitationWorkRecord,
): number {
  const citationTokens = normalizeMatchText(citation)
    .split(" ")
    .filter(Boolean);
  const citationYear = extractCitationYear(citation);
  let score = 0;

  if (citationYear && work.year) score += citationYear === work.year ? 5 : -8;

  const authorSurnames = work.authors
    .map(authorSurname)
    .filter((surname) => surname.length >= 3);
  if (
    authorSurnames[0] &&
    citationContainsToken(citationTokens, authorSurnames[0])
  ) {
    score += 5;
  }
  for (const surname of authorSurnames.slice(1)) {
    if (citationContainsToken(citationTokens, surname)) score += 2;
  }

  const titleHits = uniqueMatchTokens(work.title, 5).filter((token) =>
    citationContainsToken(citationTokens, token),
  ).length;
  score += Math.min(6, titleHits * 2);

  const journalHits = uniqueMatchTokens(work.journal ?? "", 4).filter((token) =>
    citationTokens.some(
      (citationToken) =>
        citationToken.length >= 3 &&
        (token.startsWith(citationToken) ||
          citationToken.startsWith(token.slice(0, 4))),
    ),
  ).length;
  return score + Math.min(4, journalHits);
}

function createCitationPlaceholderWork(
  paperId: string,
  index: number,
  citation: string,
): CitationWorkRecord {
  const title = citation.replace(/\s+/g, " ").trim();
  const openAlexId = `REF_${createHash("sha256")
    .update(`${paperId}\0${index}\0${title}`)
    .digest("hex")
    .slice(0, 24)}`;
  return {
    openAlexId,
    title,
    authors: [],
    journal: "PDF 参考文献",
    year: extractCitationYear(title),
    citedByCount: 0,
    referencedOpenAlexIds: [],
  };
}

function extractCitationDoi(citation: string): string | undefined {
  return normalizeCitationDoi(
    citation.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i)?.[0],
  );
}

function extractCitationYear(citation: string): number | undefined {
  const year = Number(citation.match(/\b(?:18|19|20)\d{2}\b/)?.[0]);
  return Number.isFinite(year) && year > 0 ? year : undefined;
}

function authorSurname(author: string): string {
  const parts = normalizeMatchText(author)
    .split(" ")
    .filter((part) => part && !/^(?:jr|sr|ii|iii|iv)$/.test(part));
  return parts.at(-1) ?? "";
}

function uniqueMatchTokens(value: string, minimumLength: number): string[] {
  return [
    ...new Set(
      normalizeMatchText(value)
        .split(" ")
        .filter((token) => token.length >= minimumLength),
    ),
  ];
}

function citationContainsToken(tokens: string[], token: string): boolean {
  return token.length >= 3 && tokens.includes(token);
}

function normalizeMatchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function storeWorks(
  cache: CitationGraphCache,
  works: CitationWorkRecord[],
): void {
  for (const work of works) cache.works[work.openAlexId] = work;
}

function cloneCache(cache: CitationGraphCache): CitationGraphCache {
  return {
    works: Object.fromEntries(
      Object.entries(cache.works).map(([id, work]) => [
        id,
        {
          ...work,
          authors: [...work.authors],
          referencedOpenAlexIds: [...work.referencedOpenAlexIds],
        },
      ]),
    ),
    cores: Object.fromEntries(
      Object.entries(cache.cores).map(([paperId, core]) => [
        paperId,
        {
          ...core,
          referencedOpenAlexIds: [...core.referencedOpenAlexIds],
          citingOpenAlexIds: [...core.citingOpenAlexIds],
        },
      ]),
    ),
    updatedAt: cache.updatedAt,
  };
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
