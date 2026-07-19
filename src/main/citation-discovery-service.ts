import type {
  CitationContentMatchPriority,
  CitationDiscoveryMode,
  CitationDiscoveryReason,
  CitationDiscoveryResult,
  Paper,
} from "../shared/contracts";
import type {
  CitationGraphCache,
  CitationWorkRecord,
} from "../shared/citationGraph";
import {
  normalizeCitationDoi,
  normalizeOpenAlexId,
} from "../shared/citationGraph";
import {
  CITATION_DISCOVERY_MAX_CANDIDATES,
  CITATION_DISCOVERY_PURE_SEARCH_MAX_CANDIDATES,
  buildCitationDiscoveryQueries,
  buildCitationDiscoveryTerms,
  rankCitationDiscoveryCandidates,
  type CitationDiscoveryWorkInput,
} from "../shared/citationDiscovery";
import { containsChineseText } from "../shared/translation";
import type { ArxivClient } from "./arxiv-client";
import type { CrossrefClient, CrossrefWorkRecord } from "./crossref-client";
import type { EuropePmcClient } from "./europe-pmc-client";
import type { OpenAlexClient } from "./openalex-client";

export interface DiscoverCitationWorksOptions {
  papers: Paper[];
  cache: CitationGraphCache;
  client: OpenAlexClient;
  crossref?: CrossrefClient;
  europePmc?: EuropePmcClient;
  arxiv?: ArxivClient;
  query?: string;
  limit?: number;
  contentMatchPriority?: CitationContentMatchPriority;
  mode?: CitationDiscoveryMode;
  translateQuery?: (query: string) => Promise<string>;
  now?: Date;
}

export async function discoverCitationWorks({
  papers,
  cache,
  client,
  crossref,
  europePmc,
  arxiv,
  query = "",
  limit,
  contentMatchPriority = "standard",
  mode = "contextual",
  translateQuery,
  now = new Date(),
}: DiscoverCitationWorksOptions): Promise<{
  result: CitationDiscoveryResult;
  works: CitationWorkRecord[];
}> {
  const pureSearch = mode === "pure-search";
  const maxCandidates = pureSearch
    ? CITATION_DISCOVERY_PURE_SEARCH_MAX_CANDIDATES
    : CITATION_DISCOVERY_MAX_CANDIDATES;
  const requestedLimit = Math.max(
    1,
    Math.min(maxCandidates, Math.ceil(limit ?? maxCandidates)),
  );

  if (!pureSearch && papers.length === 0) {
    throw new Error("请先选择至少一篇本地论文作为推荐起点。");
  }

  const warnings: string[] = [];
  let effectiveQuery = query.trim();
  if (pureSearch && !effectiveQuery) {
    throw new Error("纯搜索需要输入主题关键词。");
  }

  if (translateQuery && containsChineseText(effectiveQuery)) {
    try {
      const translatedQuery = (await translateQuery(effectiveQuery)).trim();
      if (translatedQuery) {
        effectiveQuery = translatedQuery;
        warnings.push(`主题关键词已自动切换为英文：${translatedQuery}`);
      }
    } catch (error) {
      warnings.push(
        `中文主题关键词翻译失败，将使用原文搜索：${errorMessage(error)}`,
      );
    }
  }

  const candidates: CitationDiscoveryWorkInput[] = pureSearch
    ? []
    : Object.values(cache.works).map((work) => ({ work }));
  const queries = pureSearch
    ? [effectiveQuery]
    : buildCitationDiscoveryQueries(papers, effectiveQuery);

  const searchLimit = Math.max(20, Math.min(100, requestedLimit));
  const primaryQueryPageCount = Math.max(
    1,
    Math.min(4, Math.ceil(requestedLimit / searchLimit)),
  );
  const pureSearchPageCount = Math.max(
    1,
    Math.min(8, Math.ceil(requestedLimit / searchLimit)),
  );
  const pureSearchVariantPageCount = Math.max(
    1,
    Math.ceil(pureSearchPageCount / 2),
  );
  const searchRequests: Array<{
    searchQuery: string;
    page: number;
    sort?: "relevance" | "publication-date";
  }> = pureSearch
    ? (["relevance", "publication-date"] as const).flatMap((sort) =>
        Array.from({ length: pureSearchVariantPageCount }, (_, pageIndex) => ({
          searchQuery: queries[0],
          page: pageIndex + 1,
          sort,
        })),
      )
    : queries.flatMap((searchQuery, queryIndex) =>
        Array.from(
          { length: queryIndex === 0 ? primaryQueryPageCount : 1 },
          (_, pageIndex) => ({
            searchQuery,
            page: pageIndex + 1,
            sort: undefined,
          }),
        ),
      );

  await mapWithConcurrency(
    searchRequests,
    3,
    async ({ searchQuery, page, sort }) => {
      try {
        const works = await client.findWorksBySearch(searchQuery, searchLimit, {
          page,
          ...(sort ? { sort } : {}),
        });
        candidates.push(
          ...works.map((work) => ({
            work,
            reasons: ["topic-match" as CitationDiscoveryReason],
          })),
        );
      } catch (error) {
        warnings.push(
          `OpenAlex 关键词检索“${searchQuery.slice(0, 42)}”失败：${errorMessage(error)}`,
        );
      }
    },
  );

  if (pureSearch) {
    const sourceRequests: Array<{
      source: string;
      run: () => Promise<CitationWorkRecord[]>;
    }> = [];

    if (crossref) {
      sourceRequests.push({
        source: "Crossref",
        run: async () =>
          (
            await crossref.findWorksByBibliographic(
              effectiveQuery,
              Math.min(100, requestedLimit),
            )
          )
            .map(crossrefToCitationWork)
            .filter((work): work is CitationWorkRecord => Boolean(work)),
      });
    }

    if (europePmc) {
      const pageCount = Math.min(2, Math.ceil(requestedLimit / 100));
      sourceRequests.push(
        ...Array.from({ length: Math.max(1, pageCount) }, (_, pageIndex) => ({
          source: "Europe PMC",
          run: () =>
            europePmc.search(effectiveQuery, {
              page: pageIndex + 1,
              pageSize: 100,
            }),
        })),
      );
    }

    if (arxiv) {
      const pageCount = Math.min(2, Math.ceil(requestedLimit / 100));
      sourceRequests.push(
        ...Array.from({ length: Math.max(1, pageCount) }, (_, pageIndex) => ({
          source: "arXiv",
          run: () =>
            arxiv.search(effectiveQuery, {
              start: pageIndex * 100,
              maxResults: 100,
            }),
        })),
      );
    }

    await mapWithConcurrency(sourceRequests, 3, async ({ source, run }) => {
      try {
        const works = await run();
        candidates.push(
          ...works.map((work) => ({
            work,
            reasons: ["topic-match" as CitationDiscoveryReason],
          })),
        );
      } catch (error) {
        warnings.push(`${source} 书目检索失败：${errorMessage(error)}`);
      }
    });
  }

  const seedCores = pureSearch
    ? []
    : papers
        .map((paper) => ({
          paper,
          core: cache.cores[paper.id],
        }))
        .filter(
          (
            item,
          ): item is {
            paper: Paper;
            core: NonNullable<CitationGraphCache["cores"][string]>;
          } => Boolean(item.core?.openAlexId),
        )
        .slice(0, 12);

  await mapWithConcurrency(seedCores, 3, async ({ paper, core }) => {
    try {
      const works = await client.getCitingWorks(core.openAlexId!, 16);
      candidates.push(
        ...works.map((work) => ({
          work,
          reasons: ["cites-library" as CitationDiscoveryReason],
          matchedPaperIds: [paper.id],
        })),
      );
    } catch (error) {
      warnings.push(`引用检索“${paper.title}”失败：${errorMessage(error)}`);
    }
  });

  if (
    !pureSearch &&
    papers.length > seedCores.length &&
    seedCores.length === 12
  ) {
    warnings.push("引用检索已优先处理前 12 篇种子论文。");
  }

  const seedOpenAlexIds = pureSearch
    ? {}
    : Object.fromEntries(
        papers.map((paper) => [paper.id, cache.cores[paper.id]?.openAlexId]),
      );
  const seedReferences = pureSearch
    ? {}
    : Object.fromEntries(
        papers.map((paper) => [
          paper.id,
          cache.cores[paper.id]?.referencedOpenAlexIds ?? [],
        ]),
      );
  const ranked = rankCitationDiscoveryCandidates({
    papers: pureSearch ? [] : papers,
    candidates,
    query: effectiveQuery,
    seedOpenAlexIds,
    seedReferences,
    limit: requestedLimit,
    maxCandidates,
    contentMatchPriority,
    now,
  });
  const works = uniqueWorks(candidates.map((candidate) => candidate.work));

  return {
    result: {
      candidates: ranked,
      query: effectiveQuery,
      terms: buildCitationDiscoveryTerms(
        pureSearch ? [] : papers,
        effectiveQuery,
      ),
      searchedAt: now.toISOString(),
      warnings,
      mode,
    },
    works,
  };
}

function crossrefToCitationWork(
  work: CrossrefWorkRecord,
): CitationWorkRecord | undefined {
  const title = work.title?.trim();
  if (!title) return undefined;
  const doi = normalizeCitationDoi(work.doi);
  const identity = doi
    ? `crossref:${doi}`
    : `crossref:${normalizeWorkTitle(title)}`;
  return {
    openAlexId: identity,
    doi,
    title,
    authors: [...work.authors],
    journal: work.journal,
    year: work.year,
    volume: work.volume,
    issue: work.issue,
    pages: work.pages,
    issn: [...work.issn],
    referencedOpenAlexIds: [],
    sourceUrl: work.sourceUrl,
    metadataSources: ["crossref"],
    matchStatus: doi ? "verified" : "probable",
    matchConfidence: doi ? 95 : 78,
  };
}

function uniqueWorks(works: CitationWorkRecord[]): CitationWorkRecord[] {
  const merged: CitationWorkRecord[] = [];
  for (const work of works) {
    const identity = findWorkIdentity(work, merged);
    const index = identity
      ? merged.findIndex(
          (candidate) => findWorkIdentity(candidate, [work]) === identity,
        )
      : -1;
    if (index < 0) {
      merged.push(work);
      continue;
    }
    merged[index] = mergeWorkMetadata(merged[index], work);
  }
  return merged;
}

function findWorkIdentity(
  work: CitationWorkRecord,
  existing: CitationWorkRecord[],
): string | undefined {
  const doi = normalizeCitationDoi(work.doi);
  const title = normalizeWorkTitle(work.title);
  const authors = new Set(normalizeAuthors(work.authors));

  for (const candidate of existing) {
    const candidateDoi = normalizeCitationDoi(candidate.doi);
    if (doi && candidateDoi && doi === candidateDoi) return `doi:${doi}`;

    const candidateTitle = normalizeWorkTitle(candidate.title);
    if (title && candidateTitle && title === candidateTitle) {
      return `title:${title}`;
    }

    if (
      title &&
      candidateTitle &&
      titleSimilarity(title, candidateTitle) >= 0.9 &&
      hasAuthorOverlap(authors, new Set(normalizeAuthors(candidate.authors)))
    ) {
      return `title-author:${title}`;
    }
  }

  if (doi) return `doi:${doi}`;
  if (title) return `title:${title}`;
  const openAlexId = normalizeOpenAlexId(work.openAlexId);
  return openAlexId
    ? `openalex:${openAlexId}`
    : work.openAlexId
      ? `source:${work.openAlexId}`
      : undefined;
}

function mergeWorkMetadata(
  current: CitationWorkRecord,
  incoming: CitationWorkRecord,
): CitationWorkRecord {
  const currentOpenAlexId = normalizeOpenAlexId(current.openAlexId);
  const incomingOpenAlexId = normalizeOpenAlexId(incoming.openAlexId);
  return {
    ...current,
    openAlexId:
      currentOpenAlexId ??
      incomingOpenAlexId ??
      current.openAlexId ??
      incoming.openAlexId,
    doi: current.doi ?? incoming.doi,
    title: current.title || incoming.title,
    authors:
      current.authors.length >= incoming.authors.length
        ? [...current.authors]
        : [...incoming.authors],
    journal: current.journal ?? incoming.journal,
    year: current.year ?? incoming.year,
    abstract: current.abstract ?? incoming.abstract,
    keywords:
      current.keywords || incoming.keywords
        ? [
            ...new Set([
              ...(current.keywords ?? []),
              ...(incoming.keywords ?? []),
            ]),
          ]
        : undefined,
    volume: current.volume ?? incoming.volume,
    issue: current.issue ?? incoming.issue,
    pages: current.pages ?? incoming.pages,
    issn: current.issn ?? incoming.issn,
    citedByCount: current.citedByCount ?? incoming.citedByCount,
    referencedOpenAlexIds: [
      ...new Set([
        ...current.referencedOpenAlexIds,
        ...incoming.referencedOpenAlexIds,
      ]),
    ],
    sourceUrl: current.sourceUrl ?? incoming.sourceUrl,
    metadataSources: [
      ...new Set([
        ...(current.metadataSources ?? []),
        ...(incoming.metadataSources ?? []),
      ]),
    ],
    matchStatus: current.matchStatus ?? incoming.matchStatus,
    matchConfidence: current.matchConfidence ?? incoming.matchConfidence,
    rawCitation: current.rawCitation ?? incoming.rawCitation,
    textQuality: current.textQuality ?? incoming.textQuality,
  };
}

function normalizeWorkTitle(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAuthors(authors: string[]): string[] {
  return authors
    .map((author) =>
      normalizeWorkTitle(author).split(" ").filter(Boolean).at(-1),
    )
    .filter((author): author is string => Boolean(author));
}

function hasAuthorOverlap(first: Set<string>, second: Set<string>): boolean {
  for (const author of first) {
    if (second.has(author)) return true;
  }
  return false;
}

function titleSimilarity(first: string, second: string): number {
  if (first === second) return 1;
  const firstTokens = new Set(first.split(" ").filter(Boolean));
  const secondTokens = new Set(second.split(" ").filter(Boolean));
  if (!firstTokens.size || !secondTokens.size) return 0;
  let shared = 0;
  for (const token of firstTokens) {
    if (secondTokens.has(token)) shared += 1;
  }
  return (2 * shared) / (firstTokens.size + secondTokens.size);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
