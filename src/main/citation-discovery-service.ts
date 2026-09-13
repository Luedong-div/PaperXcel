import type {
  CitationContentMatchPriority,
  CitationDiscoveryFilters,
  CitationDiscoveryMode,
  CitationDiscoveryResult,
  CitationSearchSource,
  Paper,
} from "../shared/contracts";
import type {
  CitationGraphCache,
  CitationWorkRecord,
} from "../shared/citationGraph";
import { normalizeCitationDoi } from "../shared/citationGraph";
import {
  CITATION_DISCOVERY_MAX_CANDIDATES,
  CITATION_DISCOVERY_PURE_SEARCH_MAX_CANDIDATES,
  buildCitationDiscoveryQueries,
  buildCitationDiscoveryTerms,
  isExcludedDiscoveryWork,
  rankCitationDiscoveryCandidates,
  parseDiscoveryDoi,
  deduplicateDiscoveryWorks,
  type CitationDiscoveryWorkInput,
} from "../shared/citationDiscovery";
import { containsChineseText } from "../shared/translation";
import type { CrossrefClient, CrossrefWorkRecord } from "./crossref-client";
import type { EuropePmcClient } from "./europe-pmc-client";
import type { OpenAlexClient } from "./openalex-client";

const PAGE_SIZE = 50;
const MAX_PAGES = 16;
const SOURCE_LABELS = {
  openalex: "OpenAlex",
  crossref: "Crossref",
  "europe-pmc": "Europe PMC",
};
interface SearchStream {
  source: CitationSearchSource;
  query: string;
  page: number;
  done: boolean;
  count: number;
  active?: boolean;
  error?: string;
}
/** Lives only in the requesting window's search session; completed pages are reused. */
export interface CitationDiscoverySession {
  query?: string;
  queries: string[];
  candidates: CitationDiscoveryWorkInput[];
  streams: SearchStream[];
  warnings: string[];
  searchedAt: string;
  seeded: boolean;
  seedOpenAlexIds: Record<string, string | undefined>;
  seedReferences: Record<string, string[]>;
  excludedCount: number;
}
export function createCitationDiscoverySession(
  now = new Date(),
): CitationDiscoverySession {
  return {
    queries: [],
    candidates: [],
    streams: [],
    warnings: [],
    searchedAt: now.toISOString(),
    seeded: false,
    seedOpenAlexIds: {},
    seedReferences: {},
    excludedCount: 0,
  };
}
export interface DiscoverCitationWorksOptions {
  papers: Paper[];
  cache: CitationGraphCache;
  client: OpenAlexClient;
  crossref?: CrossrefClient;
  europePmc?: EuropePmcClient;
  query?: string;
  limit?: number;
  contentMatchPriority?: CitationContentMatchPriority;
  mode?: CitationDiscoveryMode;
  filters?: CitationDiscoveryFilters;
  translateQuery?: (query: string) => Promise<string>;
  signal?: AbortSignal;
  onProgress?: (result: CitationDiscoveryResult) => void;
  session?: CitationDiscoverySession;
  now?: Date;
}

export async function discoverCitationWorks({
  papers,
  cache,
  client,
  crossref,
  europePmc,
  query = "",
  limit = 50,
  contentMatchPriority = "standard",
  mode = "contextual",
  filters = {},
  translateQuery,
  signal,
  onProgress,
  session = createCitationDiscoverySession(),
  now = new Date(),
}: DiscoverCitationWorksOptions): Promise<{
  result: CitationDiscoveryResult;
  works: CitationWorkRecord[];
}> {
  const pureSearch = mode === "pure-search";
  for (const year of [filters.yearFrom, filters.yearTo]) {
    if (
      year !== undefined &&
      (!Number.isInteger(year) || year < 1500 || year > 2100)
    )
      throw new Error("年份应为 1500 至 2100 之间的整数。");
  }
  if (!pureSearch && !papers.length)
    throw new Error("请先选择至少一篇本地论文作为推荐起点。");
  if (pureSearch && !query.trim())
    throw new Error("请输入研究问题、论文标题或 DOI。");
  const maxCandidates = pureSearch
    ? CITATION_DISCOVERY_PURE_SEARCH_MAX_CANDIDATES
    : CITATION_DISCOVERY_MAX_CANDIDATES;
  const requestedLimit = Math.max(
    1,
    Math.min(maxCandidates, Math.ceil(Number.isFinite(limit) ? limit : 50)),
  );
  if (filters.yearFrom && filters.yearTo && filters.yearFrom > filters.yearTo)
    throw new Error("起始年份不能晚于结束年份。");
  const availableSources: CitationSearchSource[] = [
    "openalex",
    ...(crossref ? ["crossref" as const] : []),
    ...(europePmc ? ["europe-pmc" as const] : []),
  ];
  const sources = availableSources.filter(
    (source) => !filters.sources || filters.sources.includes(source),
  );
  if (!sources.length) throw new Error("请至少选择一个论文搜索来源。");
  const failedThisRun = new Set<SearchStream>();
  const sourceErrors = new Map<CitationSearchSource, string>();
  let settled = false;

  const allRanked = () => {
    const candidates = session.candidates.filter(
      ({ work }) =>
        (!filters.yearFrom ||
          (work.year !== undefined && work.year >= filters.yearFrom)) &&
        (!filters.yearTo ||
          (work.year !== undefined && work.year <= filters.yearTo)),
    );
    const ranked = rankCitationDiscoveryCandidates({
      papers: pureSearch ? [] : papers,
      candidates,
      query: session.query ?? query,
      seedOpenAlexIds: session.seedOpenAlexIds,
      seedReferences: session.seedReferences,
      limit: maxCandidates,
      maxCandidates,
      contentMatchPriority,
      now,
    });
    if (filters.sort === "newest")
      ranked.sort(
        (a, b) =>
          (b.work.year ?? -1) - (a.work.year ?? -1) || b.score - a.score,
      );
    if (filters.sort === "citations")
      ranked.sort(
        (a, b) =>
          (b.work.citedByCount ?? -1) - (a.work.citedByCount ?? -1) ||
          b.score - a.score,
      );
    return ranked;
  };
  const snapshot = (): CitationDiscoveryResult => {
    const ranked = allRanked();
    return {
      candidates: ranked.slice(0, requestedLimit),
      query: session.query ?? query.trim(),
      originalQuery: query.trim(),
      queries: [...session.queries],
      terms: buildCitationDiscoveryTerms(
        pureSearch ? [] : papers,
        session.query ?? query,
      ),
      searchedAt: session.searchedAt,
      mode,
      warnings: [
        ...new Set([
          ...session.warnings,
          ...session.streams.flatMap((stream) =>
            stream.error
              ? [`${SOURCE_LABELS[stream.source]}：${stream.error}`]
              : [],
          ),
          ...sourceErrors.values(),
        ]),
      ],
      hasMore:
        !parseDiscoveryDoi(query) &&
        requestedLimit < maxCandidates &&
        (ranked.length > requestedLimit ||
          session.streams.some(
            (stream) => !stream.done && stream.page <= MAX_PAGES,
          )),
      cancelled: signal?.aborted || undefined,
      fetchedCount: session.candidates.length,
      excludedCount: session.excludedCount,
      sources: sources.map((source) => {
        const streams = session.streams.filter(
          (stream) => stream.source === source,
        );
        const error =
          streams.find((stream) => stream.error)?.error ??
          sourceErrors.get(source);
        return {
          id: source,
          label: SOURCE_LABELS[source],
          count: streams.reduce((sum, stream) => sum + stream.count, 0),
          error,
          status: streams.some((stream) => stream.active)
            ? "searching"
            : error
              ? "error"
              : settled ||
                  streams.every((stream) => stream.page > 1 || stream.done)
                ? "complete"
                : "pending",
        };
      }),
    };
  };
  const emit = () => onProgress?.(snapshot());
  const addWorks = (
    works: CitationWorkRecord[],
    page = 1,
    matchedPaperIds?: string[],
  ) => {
    works.forEach((work, index) => {
      if (isExcludedDiscoveryWork(work)) {
        session.excludedCount++;
        return;
      }
      session.candidates.push({
        work,
        retrievalRank: (page - 1) * PAGE_SIZE + index + 1,
        matchedPaperIds,
        reasons: matchedPaperIds?.length ? ["cites-library"] : undefined,
      });
    });
  };

  if (session.query === undefined) {
    let effectiveQuery = query.trim();
    emit();
    if (translateQuery && containsChineseText(effectiveQuery)) {
      try {
        effectiveQuery =
          (
            await withCancellation(translateQuery(effectiveQuery), signal)
          ).trim() || effectiveQuery;
      } catch (error) {
        session.warnings.push(
          `查询翻译失败，使用原文检索：${errorMessage(error)}`,
        );
      }
    }
    // A cancelled translation must not launch network searches afterwards.
    if (signal?.aborted) {
      settled = true;
      return { result: snapshot(), works: [] };
    }
    session.query = effectiveQuery;
    session.queries = pureSearch
      ? [effectiveQuery]
      : buildCitationDiscoveryQueries(papers, effectiveQuery);
    session.streams = sources.flatMap((source) =>
      (source === "openalex"
        ? session.queries
        : session.queries.slice(0, 1)
      ).map((searchQuery) => ({
        source,
        query: searchQuery,
        page: 1,
        done: false,
        count: 0,
      })),
    );
    if (!pureSearch) {
      for (const paper of papers) {
        const core = cache.cores[paper.id];
        session.seedOpenAlexIds[paper.id] = core?.openAlexId;
        session.seedReferences[paper.id] = core?.referencedOpenAlexIds ?? [];
        for (const id of [
          ...(core?.referencedOpenAlexIds ?? []),
          ...(core?.citingOpenAlexIds ?? []),
        ]) {
          if (cache.works[id]) addWorks([cache.works[id]]);
        }
      }
    }
  }

  const seed = async () => {
    if (session.seeded || pureSearch || !sources.includes("openalex")) return;
    for (const paper of papers.slice(0, 8)) {
      if (signal?.aborted) return;
      try {
        let id = session.seedOpenAlexIds[paper.id];
        if (!id && paper.doi && typeof client.getWorkByDoi === "function") {
          const work = await client.getWorkByDoi(paper.doi, signal);
          id = work?.openAlexId;
          if (work) {
            session.seedOpenAlexIds[paper.id] = id;
            session.seedReferences[paper.id] = [...work.referencedOpenAlexIds];
          }
        }
        if (id)
          addWorks(await client.getCitingWorks(id, 50, signal), 1, [paper.id]);
        emit();
      } catch (error) {
        if (!signal?.aborted)
          sourceErrors.set(
            "openalex",
            `后续引用获取失败：${errorMessage(error)}`,
          );
      }
    }
    if (!signal?.aborted) session.seeded = true;
  };
  const fetchPage = async (stream: SearchStream) => {
    if (signal?.aborted) return;
    stream.active = true;
    stream.error = undefined;
    emit();
    try {
      const doi = parseDiscoveryDoi(query);
      const sort = filters.sort ?? "relevance";
      let works: CitationWorkRecord[];
      if (stream.source === "openalex") {
        if (doi) {
          const work = await client.getWorkByDoi(doi, signal);
          works = work ? [work] : [];
        } else
          works = await client.findWorksBySearch(stream.query, PAGE_SIZE, {
            page: stream.page,
            sort: sort === "newest" ? "publication-date" : sort,
            yearFrom: filters.yearFrom,
            yearTo: filters.yearTo,
            signal,
          });
      } else if (stream.source === "crossref") {
        const records = doi
          ? [await crossref!.getWorkByDoi(doi, signal, true)].filter(
              (work): work is CrossrefWorkRecord => Boolean(work),
            )
          : await crossref!.findWorksByBibliographic(stream.query, PAGE_SIZE, {
              offset: (stream.page - 1) * PAGE_SIZE,
              yearFrom: filters.yearFrom,
              yearTo: filters.yearTo,
              sort,
              signal,
              strict: true,
            });
        works = records
          .map(crossrefToCitationWork)
          .filter((work): work is CitationWorkRecord => Boolean(work));
      } else
        works = await europePmc!.search(doi ? `DOI:${doi}` : stream.query, {
          page: stream.page,
          pageSize: PAGE_SIZE,
          yearFrom: filters.yearFrom,
          yearTo: filters.yearTo,
          sort,
          signal,
        });
      if (signal?.aborted) return;
      stream.count += works.length;
      addWorks(
        doi
          ? works.filter((work) => normalizeCitationDoi(work.doi) === doi)
          : works,
        stream.page,
      );
      stream.done = Boolean(doi) || works.length < PAGE_SIZE;
      stream.page++;
    } catch (error) {
      if (!signal?.aborted) {
        stream.error = errorMessage(error);
        failedThisRun.add(stream);
      }
    } finally {
      stream.active = false;
      emit();
    }
  };

  // All providers start together. Each response emits an authoritative, deduplicated snapshot.
  let seedPromise: Promise<void> | undefined;
  for (let round = 0; round < MAX_PAGES && !signal?.aborted; round++) {
    const streams = session.streams.filter(
      (stream) =>
        !stream.done && stream.page <= MAX_PAGES && !failedThisRun.has(stream),
    );
    if (
      !streams.length ||
      (session.streams.every((stream) => stream.page > 1 || stream.done) &&
        allRanked().length >= requestedLimit)
    )
      break;
    if (!seedPromise) seedPromise = seed();
    await Promise.allSettled(streams.map(fetchPage));
  }
  if (!seedPromise) seedPromise = seed();
  await seedPromise;
  settled = true;
  const result = snapshot();
  onProgress?.(result);
  return {
    result,
    works: deduplicateDiscoveryWorks(
      session.candidates.map(({ work }) => work),
    ),
  };
}

function crossrefToCitationWork(
  work: CrossrefWorkRecord,
): CitationWorkRecord | undefined {
  if (!work.title?.trim()) return undefined;
  const doi = normalizeCitationDoi(work.doi);
  return {
    openAlexId: `crossref:${doi ?? work.title.toLowerCase()}`,
    doi,
    title: work.title,
    authors: [...work.authors],
    journal: work.journal,
    year: work.year,
    abstract: work.abstract,
    citedByCount: work.citedByCount,
    volume: work.volume,
    issue: work.issue,
    pages: work.pages,
    issn: [...work.issn],
    referencedOpenAlexIds: [],
    sourceUrl: work.sourceUrl,
    metadataSources: ["crossref"],
    matchStatus: doi ? "verified" : "probable",
  };
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withCancellation<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("已停止搜索"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
