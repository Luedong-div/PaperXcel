import { createHash } from "node:crypto";
import {
  CITATION_GRAPH_CITING_LIMIT,
  CITATION_GRAPH_CORE_VERSION,
  CITATION_GRAPH_EXPANSION_VERSION,
  CITATION_GRAPH_FOCUSED_FIRST_ORDER_LIMIT,
  CITATION_GRAPH_FOCUSED_SECOND_ORDER_CANDIDATE_LIMIT,
  CITATION_GRAPH_FOCUSED_SECOND_ORDER_LIMIT,
  CITATION_GRAPH_FOCUSED_CITING_PER_PARENT_LIMIT,
  buildFocusedCitationGraphSnapshot,
  buildCitationGraphSnapshot,
  isCitationExpansionFresh,
  isCitationRecordFresh,
  normalizeCitationDoi,
  normalizeOpenAlexId,
  type CitationGraphExpansionRecord,
  type CitationGraphCache,
  type CitationWorkRecord,
} from "../shared/citationGraph";
import type {
  CitationGraphExpansionResult,
  CitationGraphRefreshResult,
  Paper,
} from "../shared/contracts";
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

export interface CitationGraphExpansionOptions {
  paper: Paper;
  cache: CitationGraphCache;
  client: OpenAlexClient;
  force?: boolean;
  now?: Date;
}

/**
 * 扩展单篇论文的同向二重图谱：
 *
 *   二阶参考 -> 一阶参考 -> 目标论文 -> 一阶引用 -> 二阶引用
 *
 * 参考文献侧直接复用 OpenAlex Work 的 referenced_works；
 * 引用侧按“一阶引用论文”继续请求 cites:{firstOrderId}。
 * 两侧分别容错，某一侧失败不会吞掉另一侧已经拿到的数据。
 */
export async function expandCitationGraphData({
  paper,
  cache,
  client,
  force = false,
  now = new Date(),
}: CitationGraphExpansionOptions): Promise<{
  cache: CitationGraphCache;
  result: CitationGraphExpansionResult;
}> {
  const nextCache = cloneCache(cache);
  const core = nextCache.cores[paper.id];
  if (!core) {
    throw new Error("请先刷新这篇论文的一阶引文图谱，再生成同向二重图谱。");
  }

  const previous = nextCache.expansions?.[paper.id];
  if (
    !force &&
    isCitationExpansionFresh(previous, now.getTime()) &&
    previous &&
    expansionWorksAvailable(previous, nextCache)
  ) {
    return {
      cache: nextCache,
      result: {
        snapshot: buildFocusedCitationGraphSnapshot(
          paper,
          nextCache,
          previous,
        ),
        paperId: paper.id,
        cached: true,
      },
    };
  }

  const errors: string[] = [];
  const rootOpenAlexId = normalizeOpenAlexId(core.openAlexId);

  // 先补齐一阶 Work，避免旧缓存只有 ID 没有元数据时二重图谱出现空节点。
  const referenceCandidates = uniqueNormalizedIds(
    core.referencedOpenAlexIds,
  );
  const citingCandidates = uniqueNormalizedIds(core.citingOpenAlexIds);
  await ensureWorks(referenceCandidates, nextCache, client, errors, "参考文献");
  await ensureWorks(citingCandidates, nextCache, client, errors, "引用论文");

  const referenceFirstOrderIds = selectFocusedFirstOrderIds(
    referenceCandidates,
    nextCache,
  );
  const citingFirstOrderIds = selectFocusedFirstOrderIds(
    citingCandidates,
    nextCache,
  );
  const truncatedReferenceFirstOrderCount = Math.max(
    0,
    referenceCandidates.length - referenceFirstOrderIds.length,
  );
  const truncatedCitingFirstOrderCount = Math.max(
    0,
    citingCandidates.length - citingFirstOrderIds.length,
  );

  const referenceSecondOrderParentIds = new Map<string, Set<string>>();
  const referenceSecondOrderCandidates = uniqueNormalizedIds(
    referenceFirstOrderIds.flatMap(
      (id) => nextCache.works[id]?.referencedOpenAlexIds ?? [],
    ),
  ).filter(
    (id) =>
      id !== rootOpenAlexId &&
      !referenceFirstOrderIds.includes(id) &&
      !referenceCandidates.includes(id),
  );
  for (const parentId of referenceFirstOrderIds) {
    for (const childId of nextCache.works[parentId]?.referencedOpenAlexIds ??
      []) {
      const normalized = normalizeOpenAlexId(childId);
      if (
        !normalized ||
        normalized === rootOpenAlexId ||
        referenceFirstOrderIds.includes(normalized)
      ) {
        continue;
      }
      const parents = referenceSecondOrderParentIds.get(normalized) ?? new Set();
      parents.add(parentId);
      referenceSecondOrderParentIds.set(normalized, parents);
    }
  }

  const limitedReferenceCandidates = rankWorkIds(
    referenceSecondOrderCandidates,
    nextCache,
  ).slice(0, CITATION_GRAPH_FOCUSED_SECOND_ORDER_CANDIDATE_LIMIT);
  await ensureWorks(
    limitedReferenceCandidates,
    nextCache,
    client,
    errors,
    "二阶参考文献",
  );
  const referenceSecondOrderIds = rankWorkIds(
    limitedReferenceCandidates.filter((id) => Boolean(nextCache.works[id])),
    nextCache,
  ).slice(0, CITATION_GRAPH_FOCUSED_SECOND_ORDER_LIMIT);

  const citingSecondOrderParentIds = new Map<string, Set<string>>();
  await mapWithConcurrency(citingFirstOrderIds, 3, async (parentId) => {
    try {
      const citingWorks = await client.getCitingWorks(
        parentId,
        CITATION_GRAPH_FOCUSED_CITING_PER_PARENT_LIMIT,
      );
      storeWorks(nextCache, citingWorks);
      for (const child of citingWorks) {
        const childId = normalizeOpenAlexId(child.openAlexId);
        if (
          !childId ||
          childId === rootOpenAlexId ||
          citingFirstOrderIds.includes(childId)
        ) {
          continue;
        }
        const parents = citingSecondOrderParentIds.get(childId) ?? new Set();
        parents.add(parentId);
        citingSecondOrderParentIds.set(childId, parents);
      }
    } catch (error) {
      errors.push(
        `引用论文 ${parentId} 的二阶扩展失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  const citingSecondOrderCandidates = rankWorkIds(
    [...citingSecondOrderParentIds.keys()],
    nextCache,
  );
  const citingSecondOrderIds = citingSecondOrderCandidates.slice(
    0,
    CITATION_GRAPH_FOCUSED_SECOND_ORDER_LIMIT,
  );

  const expansion: CitationGraphExpansionRecord = {
    version: CITATION_GRAPH_EXPANSION_VERSION,
    paperId: paper.id,
    rootOpenAlexId,
    referenceFirstOrderIds,
    referenceSecondOrderIds,
    referenceSecondOrderParentIds: toParentIdRecord(
      referenceSecondOrderIds,
      referenceSecondOrderParentIds,
    ),
    citingFirstOrderIds,
    citingSecondOrderIds,
    citingSecondOrderParentIds: toParentIdRecord(
      citingSecondOrderIds,
      citingSecondOrderParentIds,
    ),
    truncatedReferenceCount:
      truncatedReferenceFirstOrderCount +
      Math.max(
        0,
        referenceSecondOrderCandidates.length -
          referenceSecondOrderIds.length,
      ),
    truncatedCitingCount:
      truncatedCitingFirstOrderCount +
      Math.max(
        0,
        citingSecondOrderCandidates.length - citingSecondOrderIds.length,
      ),
    errors: [...errors],
    fetchedAt: now.toISOString(),
  };
  nextCache.expansions ??= {};
  nextCache.expansions[paper.id] = expansion;
  nextCache.updatedAt = now.toISOString();

  return {
    cache: nextCache,
    result: {
      snapshot: buildFocusedCitationGraphSnapshot(
        paper,
        nextCache,
        expansion,
        errors,
      ),
      paperId: paper.id,
      cached: false,
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
    expansions: Object.fromEntries(
      Object.entries(cache.expansions ?? {}).map(([paperId, expansion]) => [
        paperId,
        {
          ...expansion,
          referenceFirstOrderIds: [...expansion.referenceFirstOrderIds],
          referenceSecondOrderIds: [...expansion.referenceSecondOrderIds],
          referenceSecondOrderParentIds: cloneParentIdRecord(
            expansion.referenceSecondOrderParentIds,
          ),
          citingFirstOrderIds: [...expansion.citingFirstOrderIds],
          citingSecondOrderIds: [...expansion.citingSecondOrderIds],
          citingSecondOrderParentIds: cloneParentIdRecord(
            expansion.citingSecondOrderParentIds,
          ),
          errors: expansion.errors ? [...expansion.errors] : undefined,
        },
      ]),
    ),
    updatedAt: cache.updatedAt,
  };
}

function expansionWorksAvailable(
  expansion: CitationGraphExpansionRecord,
  cache: CitationGraphCache,
): boolean {
  const ids = [
    ...expansion.referenceFirstOrderIds,
    ...expansion.referenceSecondOrderIds,
    ...expansion.citingFirstOrderIds,
    ...expansion.citingSecondOrderIds,
  ];
  return ids.every((id) => Boolean(cache.works[id]));
}

async function ensureWorks(
  ids: string[],
  cache: CitationGraphCache,
  client: OpenAlexClient,
  errors: string[],
  label: string,
): Promise<void> {
  const missing = ids.filter((id) => !cache.works[id]);
  if (!missing.length) return;
  try {
    storeWorks(cache, await client.getWorksByOpenAlexIds(missing));
  } catch (error) {
    errors.push(
      `${label}元数据获取失败：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function selectFocusedFirstOrderIds(
  ids: string[],
  cache: CitationGraphCache,
): string[] {
  return rankWorkIds(ids, cache).slice(
    0,
    CITATION_GRAPH_FOCUSED_FIRST_ORDER_LIMIT,
  );
}

function rankWorkIds(ids: string[], cache: CitationGraphCache): string[] {
  return [...new Set(ids)].sort((firstId, secondId) => {
    const first = cache.works[firstId];
    const second = cache.works[secondId];
    return (
      (second?.citedByCount ?? -1) - (first?.citedByCount ?? -1) ||
      (second?.year ?? 0) - (first?.year ?? 0) ||
      (first?.title ?? firstId).localeCompare(second?.title ?? secondId) ||
      firstId.localeCompare(secondId)
    );
  });
}

function uniqueNormalizedIds(ids: string[]): string[] {
  return [
    ...new Set(
      ids.map(normalizeOpenAlexId).filter((id): id is string => Boolean(id)),
    ),
  ];
}

function toParentIdRecord(
  ids: string[],
  parents: Map<string, Set<string>>,
): Record<string, string[]> {
  return Object.fromEntries(
    ids.map((id) => [id, [...(parents.get(id) ?? new Set<string>())]]),
  );
}

function cloneParentIdRecord(
  record: Record<string, string[]>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(record).map(([id, parentIds]) => [id, [...parentIds]]),
  );
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
