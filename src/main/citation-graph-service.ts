import { createHash } from "node:crypto";
import {
  CITATION_GRAPH_CITING_LIMIT,
  CITATION_GRAPH_CORE_VERSION,
  buildCitationGraphSnapshot,
  isCitationRecordFresh,
  normalizeCitationDoi,
  normalizeOpenAlexId,
  type CitationGraphCache,
  type CitationWorkRecord,
} from "../shared/citationGraph";
import type { CitationGraphRefreshResult, Paper } from "../shared/contracts";
import { CrossrefClient, type CrossrefWorkRecord } from "./crossref-client";
import { OpenAlexClient } from "./openalex-client";
import {
  resolveReferenceWorks,
  retryUnresolvedReferenceWorksWithAi,
  type CitationReferenceSearchHint,
  type CitationReferenceSearchRequest,
} from "./reference-resolver";

export interface CitationGraphRefreshOptions {
  papers: Paper[];
  cache: CitationGraphCache;
  client: OpenAlexClient;
  force?: boolean;
  extractLocalReferenceDois?: (paper: Paper) => Promise<string[]>;
  extractLocalReferenceCitations?: (paper: Paper) => Promise<string[]>;
  extractReferenceSearchHints?: (
    references: CitationReferenceSearchRequest[],
  ) => Promise<CitationReferenceSearchHint[]>;
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
  extractReferenceSearchHints,
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
  const crossref = new CrossrefClient(fetchImpl);
  const libraryDois = new Set(
    papers
      .map((paper) => normalizeCitationDoi(paper.doi))
      .filter((doi): doi is string => Boolean(doi)),
  );

  await mapWithConcurrency(papers, 3, async (paper) => {
    const previous = nextCache.cores[paper.id];
    const previousOpenAlexId = normalizeOpenAlexId(previous?.openAlexId);
    const hasCachedCoreWork =
      !previousOpenAlexId || Boolean(nextCache.works[previousOpenAlexId]);
    if (
      !force &&
      isCitationRecordFresh(previous, now.getTime()) &&
      hasCachedCoreWork
    ) {
      skippedPapers += 1;
      return;
    }
    try {
      const core = paper.doi
        ? await refreshDoiPaper(
            paper,
            nextCache,
            client,
            crossref,
            libraryDois,
            extractLocalReferenceCitations,
            extractReferenceSearchHints,
            now,
          )
        : await refreshLocalPaper(
            paper,
            nextCache,
            client,
            crossref,
            extractLocalReferenceDois,
            extractLocalReferenceCitations,
            extractReferenceSearchHints,
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
  crossref: CrossrefClient,
  libraryDois: Set<string>,
  extractLocalReferenceCitations: CitationGraphRefreshOptions["extractLocalReferenceCitations"],
  extractReferenceSearchHints: CitationGraphRefreshOptions["extractReferenceSearchHints"],
  now: Date,
) {
  let openAlexLookupError: Error | undefined;
  const work = await client.getWorkByDoi(paper.doi!).catch((error: unknown) => {
    openAlexLookupError =
      error instanceof Error ? error : new Error(String(error));
    return undefined;
  });
  if (work) cache.works[work.openAlexId] = work;

  const citations = extractLocalReferenceCitations
    ? await extractLocalReferenceCitations(paper).catch(() => [])
    : [];
  let referencedWorks = work
    ? await client
        .getWorksByOpenAlexIds(work.referencedOpenAlexIds)
        .catch(() => [])
    : [];
  if (referencedWorks.length === 0) {
    const sourceDoi = normalizeCitationDoi(paper.doi);
    const crossrefDois = (await crossref.getReferenceDois(paper.doi!)).filter(
      (doi) => doi !== sourceDoi,
    );
    if (crossrefDois.length > 0) {
      referencedWorks = await client
        .getWorksByDois(crossrefDois)
        .catch(() => []);
      if (referencedWorks.length === 0) {
        referencedWorks = (await crossref.getWorksByDois(crossrefDois)).map(
          createCrossrefOnlyWork,
        );
      }
    }
  }

  const initiallyResolvedReferences =
    citations.length > 0
      ? await resolveReferenceWorks({
          paperId: paper.id,
          citations,
          knownWorks: referencedWorks,
          sourceDoi: paper.doi,
          openAlex: client,
          crossref,
        })
      : [];
  const resolvedReferences =
    initiallyResolvedReferences.length > 0 && extractReferenceSearchHints
      ? await retryUnresolvedReferenceWorksWithAi({
          paperId: paper.id,
          works: initiallyResolvedReferences,
          sourceDoi: paper.doi,
          openAlex: client,
          crossref,
          extractSearchHints: extractReferenceSearchHints,
        })
      : initiallyResolvedReferences;
  const selectedReferences =
    citations.length === 0
      ? selectRelatedWorks(referencedWorks, undefined, libraryDois)
      : citations.length < referencedWorks.length
        ? combineReferenceWorks(resolvedReferences, referencedWorks)
        : resolvedReferences;
  if (
    !work &&
    openAlexLookupError &&
    selectedReferences.length === 0 &&
    citations.length === 0
  ) {
    throw openAlexLookupError;
  }
  storeWorks(cache, selectedReferences);

  const citingWorks = work
    ? await client
        .getCitingWorks(work.openAlexId, CITATION_GRAPH_CITING_LIMIT)
        .catch(() => [])
    : [];
  storeWorks(cache, citingWorks);
  const selectedCitingWorks = selectRelatedWorks(
    citingWorks,
    CITATION_GRAPH_CITING_LIMIT,
  );

  return {
    version: CITATION_GRAPH_CORE_VERSION,
    paperId: paper.id,
    openAlexId: work?.openAlexId,
    referencedOpenAlexIds: selectedReferences.map((item) => item.openAlexId),
    citingOpenAlexIds: selectedCitingWorks.map((item) => item.openAlexId),
    fetchedAt: now.toISOString(),
  };
}

async function refreshLocalPaper(
  paper: Paper,
  cache: CitationGraphCache,
  client: OpenAlexClient,
  crossref: CrossrefClient,
  extractLocalReferenceDois: CitationGraphRefreshOptions["extractLocalReferenceDois"],
  extractLocalReferenceCitations: CitationGraphRefreshOptions["extractLocalReferenceCitations"],
  extractReferenceSearchHints: CitationGraphRefreshOptions["extractReferenceSearchHints"],
  now: Date,
) {
  const dois = extractLocalReferenceDois
    ? await extractLocalReferenceDois(paper)
    : [];
  const normalizedDois = dois
    .map(normalizeCitationDoi)
    .filter((doi): doi is string => Boolean(doi));
  let works = await client.getWorksByDois(normalizedDois).catch(() => []);
  if (works.length === 0 && normalizedDois.length > 0) {
    works = (await crossref.getWorksByDois(normalizedDois)).map(
      createCrossrefOnlyWork,
    );
  }
  const citations = extractLocalReferenceCitations
    ? await extractLocalReferenceCitations(paper).catch(() => [])
    : [];
  const initiallyResolvedReferences =
    citations.length > 0
      ? await resolveReferenceWorks({
          paperId: paper.id,
          citations,
          knownWorks: works,
          openAlex: client,
          crossref,
        })
      : [];
  const resolvedReferences =
    initiallyResolvedReferences.length > 0 && extractReferenceSearchHints
      ? await retryUnresolvedReferenceWorksWithAi({
          paperId: paper.id,
          works: initiallyResolvedReferences,
          openAlex: client,
          crossref,
          extractSearchHints: extractReferenceSearchHints,
        })
      : initiallyResolvedReferences;
  const selectedReferences =
    citations.length === 0
      ? selectRelatedWorks(works)
      : citations.length < works.length
        ? combineReferenceWorks(resolvedReferences, works)
        : resolvedReferences;
  storeWorks(cache, selectedReferences);
  return {
    version: CITATION_GRAPH_CORE_VERSION,
    paperId: paper.id,
    referencedOpenAlexIds: selectedReferences.map((item) => item.openAlexId),
    citingOpenAlexIds: [],
    fetchedAt: now.toISOString(),
  };
}

function combineReferenceWorks(
  resolved: CitationWorkRecord[],
  fallback: CitationWorkRecord[],
): CitationWorkRecord[] {
  const selected = new Map<string, CitationWorkRecord>();
  for (const work of [...resolved, ...fallback]) {
    const identity = normalizeCitationDoi(work.doi) ?? work.openAlexId;
    if (!selected.has(identity)) selected.set(identity, work);
  }
  return [...selected.values()];
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
      (second.citedByCount ?? -1) - (first.citedByCount ?? -1) ||
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

function storeWorks(
  cache: CitationGraphCache,
  works: CitationWorkRecord[],
): void {
  for (const work of works) cache.works[work.openAlexId] = work;
}

function createCrossrefOnlyWork(work: CrossrefWorkRecord): CitationWorkRecord {
  const identity =
    work.doi ??
    [work.title, work.year, work.volume, work.pages].filter(Boolean).join("\0");
  return {
    openAlexId: `CR_${createHash("sha256")
      .update(identity)
      .digest("hex")
      .slice(0, 24)}`,
    doi: work.doi,
    title: work.title ?? (work.doi ? `DOI ${work.doi}` : "未解析参考文献"),
    authors: [...work.authors],
    journal: work.journal,
    year: work.year,
    volume: work.volume,
    issue: work.issue,
    pages: work.pages,
    issn: [...work.issn],
    citedByCount: undefined,
    referencedOpenAlexIds: [],
    sourceUrl: work.sourceUrl,
    metadataSources: ["crossref"],
    matchStatus: "verified",
    matchConfidence: 100,
  };
}

function cloneCache(cache: CitationGraphCache): CitationGraphCache {
  return {
    works: Object.fromEntries(
      Object.entries(cache.works).map(([id, work]) => [
        id,
        {
          ...work,
          authors: [...work.authors],
          issn: work.issn ? [...work.issn] : undefined,
          metadataSources: work.metadataSources
            ? [...work.metadataSources]
            : undefined,
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
