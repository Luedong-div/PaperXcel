import type {
  CitationContentMatchPriority,
  CitationDiscoveryCandidate,
  CitationDiscoveryReason,
  CitationGraphNode,
  Paper,
} from "./contracts";
import {
  normalizeCitationDoi,
  normalizeOpenAlexId,
  type CitationWorkRecord,
} from "./citationGraph";

export interface CitationDiscoveryWorkInput {
  work: CitationWorkRecord;
  reasons?: CitationDiscoveryReason[];
  matchedPaperIds?: string[];
  retrievalRank?: number;
}

export interface RankCitationDiscoveryInput {
  papers: Paper[];
  candidates: CitationDiscoveryWorkInput[];
  query?: string;
  seedOpenAlexIds?: Record<string, string | undefined>;
  seedReferences?: Record<string, string[]>;
  limit?: number;
  maxCandidates?: number;
  contentMatchPriority?: CitationContentMatchPriority;
  now?: Date;
}

export const CITATION_DISCOVERY_MAX_CANDIDATES = 400;
export const CITATION_DISCOVERY_PURE_SEARCH_MAX_CANDIDATES = 800;
export const CITATION_DISCOVERY_PURE_SEARCH_DEFAULT_CANDIDATES = 50;
export const CITATION_DISCOVERY_PAGE_SIZE = 50;

const CONTENT_MATCH_MAX_SCORE: Record<CitationContentMatchPriority, number> = {
  low: 25,
  standard: 45,
  high: 65,
};

const STOP_WORDS = new Set([
  "about",
  "after",
  "against",
  "also",
  "and",
  "among",
  "analysis",
  "based",
  "between",
  "both",
  "for",
  "from",
  "have",
  "into",
  "of",
  "on",
  "method",
  "methods",
  "paper",
  "results",
  "study",
  "that",
  "the",
  "their",
  "these",
  "this",
  "through",
  "to",
  "using",
  "with",
  "without",
  "研究",
  "方法",
  "结果",
  "论文",
  "基于",
  "一种",
]);

export function buildCitationDiscoveryTerms(
  papers: Paper[],
  query = "",
  limit = 14,
): string[] {
  const scores = new Map<string, number>();
  const add = (value: string | undefined, weight: number): void => {
    for (const token of tokenizeResearchText(value ?? "")) {
      scores.set(token, (scores.get(token) ?? 0) + weight);
    }
  };

  add(query, 12);
  for (const paper of papers) {
    add(paper.title, 4);
    add(paper.abstract, 1);
    for (const tag of paper.tags) add(tag, 7);
  }

  return [...scores.entries()]
    .sort(
      ([firstTerm, firstScore], [secondTerm, secondScore]) =>
        secondScore - firstScore ||
        secondTerm.length - firstTerm.length ||
        firstTerm.localeCompare(secondTerm),
    )
    .slice(0, Math.max(1, limit))
    .map(([term]) => term);
}

export function buildCitationDiscoveryQueries(
  papers: Paper[],
  query = "",
): string[] {
  const normalizedQuery = normalizeSpace(query);
  const terms = buildCitationDiscoveryTerms(papers, normalizedQuery, 10);
  // Preserve research phrases. Searching every individual word loses the user's topic.
  const queries = (
    normalizedQuery
      ? [
          normalizedQuery,
          ...normalizedQuery
            .split(/[,，;；]/u)
            .filter((part) => part.trim().includes(" ")),
        ]
      : [
          ...papers.slice(0, 2).map((paper) => paper.title),
          terms.slice(0, 6).join(" "),
        ]
  )
    .map((value) => normalizeSpace(value).slice(0, 360))
    .filter(Boolean);
  return [...new Set(queries)].slice(0, 3);
}

export function rankCitationDiscoveryCandidates({
  papers,
  candidates,
  query = "",
  seedOpenAlexIds = {},
  seedReferences = {},
  limit = CITATION_DISCOVERY_MAX_CANDIDATES,
  maxCandidates = CITATION_DISCOVERY_MAX_CANDIDATES,
  contentMatchPriority = "standard",
  now = new Date(),
}: RankCitationDiscoveryInput): CitationDiscoveryCandidate[] {
  const localDois = new Set(
    papers
      .map((paper) => normalizeCitationDoi(paper.doi))
      .filter((doi): doi is string => Boolean(doi)),
  );
  const localOpenAlexIds = new Set(
    Object.values(seedOpenAlexIds)
      .map(normalizeOpenAlexId)
      .filter((id): id is string => Boolean(id)),
  );
  const localTitles = new Set(
    papers.map((paper) => normalizeTitle(paper.title)).filter(Boolean),
  );
  const terms = buildCitationDiscoveryTerms(papers, query);
  const seedReferenceSets = new Map(
    Object.entries(seedReferences).map(([paperId, ids]) => [
      paperId,
      new Set(ids.map(normalizeOpenAlexId).filter(Boolean)),
    ]),
  );
  const seedOpenAlexByPaper = new Map(
    Object.entries(seedOpenAlexIds)
      .map(([paperId, id]) => [paperId, normalizeOpenAlexId(id)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
  );
  const maxCitedBy = Math.max(
    1,
    ...candidates.map((candidate) => candidate.work.citedByCount ?? 0),
  );
  const merged = new Map<string, CitationDiscoveryWorkInput>();

  for (const candidate of candidates) {
    if (isExcludedDiscoveryWork(candidate.work)) continue;
    const doi = normalizeCitationDoi(candidate.work.doi);
    const openAlexId = normalizeOpenAlexId(candidate.work.openAlexId);
    if (
      (doi && localDois.has(doi)) ||
      (openAlexId && localOpenAlexIds.has(openAlexId)) ||
      localTitles.has(normalizeTitle(candidate.work.title))
    ) {
      continue;
    }
    const identity = findCandidateIdentity(candidate.work, merged);
    if (!identity) continue;
    const previous = merged.get(identity);
    if (!previous) {
      merged.set(identity, {
        work: candidate.work,
        reasons: unique(candidate.reasons ?? []),
        matchedPaperIds: unique(candidate.matchedPaperIds ?? []),
        retrievalRank: candidate.retrievalRank,
      });
      continue;
    }
    previous.work = mergeCitationWorkMetadata(previous.work, candidate.work);
    previous.retrievalRank = Math.min(
      previous.retrievalRank ?? Infinity,
      candidate.retrievalRank ?? Infinity,
    );
    previous.reasons = unique([
      ...(previous.reasons ?? []),
      ...(candidate.reasons ?? []),
    ]);
    previous.matchedPaperIds = unique([
      ...(previous.matchedPaperIds ?? []),
      ...(candidate.matchedPaperIds ?? []),
    ]);
  }

  const ranked = [...merged.values()].map((candidate) => {
    const referenced = new Set(
      candidate.work.referencedOpenAlexIds
        .map(normalizeOpenAlexId)
        .filter((id): id is string => Boolean(id)),
    );
    const matchedPaperIds = new Set(candidate.matchedPaperIds ?? []);
    let sharedReferenceCount = 0;
    for (const [paperId, seedReferencesForPaper] of seedReferenceSets) {
      const shared = intersectionSize(referenced, seedReferencesForPaper);
      if (shared > 0) {
        sharedReferenceCount += shared;
        matchedPaperIds.add(paperId);
      }
    }
    let citesLibrary = false;
    for (const [paperId, seedOpenAlexId] of seedOpenAlexByPaper) {
      if (!referenced.has(seedOpenAlexId)) continue;
      citesLibrary = true;
      matchedPaperIds.add(paperId);
    }

    const reasons = new Set<CitationDiscoveryReason>(
      (candidate.reasons ?? []).filter((reason) => reason !== "topic-match"),
    );
    if (sharedReferenceCount > 0) reasons.add("shared-references");
    if (citesLibrary) reasons.add("cites-library");
    const exactDoi =
      parseDiscoveryDoi(query) === normalizeCitationDoi(candidate.work.doi) &&
      Boolean(parseDiscoveryDoi(query));
    const relevanceScore = exactDoi
      ? CONTENT_MATCH_MAX_SCORE[contentMatchPriority]
      : scoreRelevance(
          candidate.work,
          terms,
          CONTENT_MATCH_MAX_SCORE[contentMatchPriority],
        );
    if (relevanceScore > 0) reasons.add("topic-match");
    const citationImpactScore = Math.round(
      (Math.log1p(candidate.work.citedByCount ?? 0) / Math.log1p(maxCitedBy)) *
        20,
    );
    const recencyScore = scoreRecency(candidate.work.year, now.getFullYear());
    const relationScore = Math.min(
      20,
      (citesLibrary ? 9 : 0) +
        Math.min(8, sharedReferenceCount * 2) +
        Math.min(3, matchedPaperIds.size),
    );
    const score = Math.min(
      100,
      Math.round(
        exactDoi
          ? 100
          : relevanceScore +
              relationScore +
              // Popularity is a tie breaker; it must not rescue an unrelated paper.
              (relevanceScore > 0 || relationScore > 0
                ? (citationImpactScore + recencyScore) * 0.35
                : 0) +
              (candidate.retrievalRank && relevanceScore > 0
                ? 6 / Math.sqrt(candidate.retrievalRank)
                : 0),
      ),
    );

    return {
      work: toDiscoveryNode(candidate.work, citesLibrary),
      score,
      relevanceScore,
      citationImpactScore,
      recencyScore,
      sharedReferenceCount,
      matchedPaperIds: [...matchedPaperIds],
      reasons: [...reasons],
    } satisfies CitationDiscoveryCandidate;
  });

  return ranked
    .filter((candidate) => candidate.reasons.length > 0)
    .sort(
      (first, second) =>
        second.score - first.score ||
        second.matchedPaperIds.length - first.matchedPaperIds.length ||
        (second.work.citedByCount ?? -1) - (first.work.citedByCount ?? -1) ||
        (second.work.year ?? 0) - (first.work.year ?? 0) ||
        first.work.title.localeCompare(second.work.title),
    )
    .slice(
      0,
      Math.max(
        1,
        Math.min(Math.ceil(limit), Math.max(1, Math.ceil(maxCandidates))),
      ),
    );
}

export function tokenizeResearchText(value: string): string[] {
  return unique(
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}][\p{L}\p{N}-]{1,}/gu)
      ?.map((token) => token.replace(/^-+|-+$/g, ""))
      .filter(
        (token) =>
          token.length >= 2 &&
          token.length <= 48 &&
          !STOP_WORDS.has(token) &&
          !/^\d+$/.test(token),
      ) ?? [],
  );
}

export function mergeCitationWorkMetadata(
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
    authors:
      current.authors.length > 0 ? current.authors : [...incoming.authors],
    journal: current.journal ?? incoming.journal,
    year: current.year ?? incoming.year,
    abstract: current.abstract ?? incoming.abstract,
    keywords:
      current.keywords && current.keywords.length > 0
        ? unique([...current.keywords, ...(incoming.keywords ?? [])])
        : incoming.keywords
          ? [...incoming.keywords]
          : undefined,
    volume: current.volume ?? incoming.volume,
    issue: current.issue ?? incoming.issue,
    pages: current.pages ?? incoming.pages,
    issn: current.issn ?? incoming.issn,
    citedByCount: current.citedByCount ?? incoming.citedByCount,
    referencedOpenAlexIds: unique([
      ...current.referencedOpenAlexIds,
      ...incoming.referencedOpenAlexIds,
    ]),
    sourceUrl: current.sourceUrl ?? incoming.sourceUrl,
    metadataSources: unique([
      ...(current.metadataSources ?? []),
      ...(incoming.metadataSources ?? []),
    ]),
    matchStatus: current.matchStatus ?? incoming.matchStatus,
    matchConfidence: current.matchConfidence ?? incoming.matchConfidence,
    rawCitation: current.rawCitation ?? incoming.rawCitation,
    textQuality: current.textQuality ?? incoming.textQuality,
  };
}

export function parseDiscoveryDoi(query: string): string | undefined {
  const normalized = normalizeCitationDoi(query);
  return normalized && /^10\.\d{4,9}\/\S+$/i.test(normalized)
    ? normalized
    : undefined;
}

export function deduplicateDiscoveryWorks(
  works: CitationWorkRecord[],
): CitationWorkRecord[] {
  const merged = new Map<string, CitationDiscoveryWorkInput>();
  for (const work of works) {
    if (isExcludedDiscoveryWork(work)) continue;
    const identity = findCandidateIdentity(work, merged);
    if (!identity) continue;
    const previous = merged.get(identity);
    merged.set(identity, {
      work: previous ? mergeCitationWorkMetadata(previous.work, work) : work,
    });
  }
  return [...merged.values()].map(({ work }) => work);
}

function findCandidateIdentity(
  work: CitationWorkRecord,
  merged: Map<string, CitationDiscoveryWorkInput>,
): string | undefined {
  const doi = normalizeCitationDoi(work.doi);
  const title = normalizeTitle(work.title);
  const authors = normalizedAuthorFamilies(work.authors);
  const openAlexId = normalizeOpenAlexId(work.openAlexId);

  for (const [identity, previous] of merged) {
    const previousDoi = normalizeCitationDoi(previous.work.doi);
    if (doi && previousDoi && doi === previousDoi) return identity;
    if (
      openAlexId &&
      openAlexId === normalizeOpenAlexId(previous.work.openAlexId)
    )
      return identity;
    if (doi && previousDoi && doi !== previousDoi) continue;

    const previousTitle = normalizeTitle(previous.work.title);
    if (
      title &&
      title === previousTitle &&
      (title.length >= 24 ||
        authorsOverlap(
          authors,
          normalizedAuthorFamilies(previous.work.authors),
        ))
    )
      return identity;

    if (
      title &&
      previousTitle &&
      titleSimilarity(title, previousTitle) >= 0.9 &&
      (!work.year ||
        !previous.work.year ||
        Math.abs(work.year - previous.work.year) <= 1) &&
      authorsOverlap(authors, normalizedAuthorFamilies(previous.work.authors))
    ) {
      return identity;
    }
  }

  if (doi) return `doi:${doi}`;
  if (title) return `title:${title}`;
  if (openAlexId) return `openalex:${openAlexId}`;
  return undefined;
}

function normalizedAuthorFamilies(authors: string[]): Set<string> {
  return new Set(
    authors
      .map((author) => normalizeTitle(author).split(" ").filter(Boolean).at(-1))
      .filter((author): author is string => Boolean(author)),
  );
}

function authorsOverlap(first: Set<string>, second: Set<string>): boolean {
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

function scoreRelevance(
  work: CitationWorkRecord,
  terms: string[],
  maxScore: number,
): number {
  if (!terms.length) return 0;
  const title = new Set(tokenizeResearchText(work.title));
  const body = normalizeSpace(
    [
      work.title,
      work.abstract,
      work.journal,
      ...(work.keywords ?? []),
      ...work.authors,
    ]
      .filter(Boolean)
      .join(" "),
  ).toLocaleLowerCase();
  const bodyTokens = new Set(tokenizeResearchText(body));
  let matchedWeight = 0;
  let totalWeight = 0;
  for (const [index, term] of terms.entries()) {
    const weight = Math.max(1, terms.length - index);
    totalWeight += weight * 3;
    if (title.has(term)) matchedWeight += weight * 3;
    else if (bodyTokens.has(term)) matchedWeight += weight;
  }
  return Math.round(
    (matchedWeight / Math.max(1, totalWeight)) * Math.max(0, maxScore),
  );
}

/** Also excludes arXiv-only records returned by aggregators and old discovery caches. */
export function isExcludedDiscoveryWork(work: {
  openAlexId?: string;
  id?: string;
  doi?: string;
  journal?: string;
  sourceUrl?: string;
  metadataSources?: string[];
}): boolean {
  const doi = normalizeCitationDoi(work.doi);
  return (
    /^10\.48550\/arxiv\./i.test(doi ?? "") ||
    /^(?:external:)?arxiv:/i.test(work.openAlexId ?? work.id ?? "") ||
    /^arxiv(?:\b|\s*:)/i.test(work.journal ?? "") ||
    (!doi &&
      (/^https?:\/\/(?:[^/]+\.)?arxiv\.org(?:\/|$)/i.test(
        work.sourceUrl ?? "",
      ) ||
        (work.metadataSources?.every((source) => source === "arxiv") === true &&
          work.metadataSources.length > 0)))
  );
}

function scoreRecency(year: number | undefined, currentYear: number): number {
  if (!year) return 4;
  const age = Math.max(0, currentYear - year);
  return Math.max(2, Math.round(15 - Math.min(18, age) * 0.7));
}

function toDiscoveryNode(
  work: CitationWorkRecord,
  citesLibrary: boolean,
): CitationGraphNode {
  const openAlexId = normalizeOpenAlexId(work.openAlexId);
  return {
    id: `external:${openAlexId ?? work.openAlexId}`,
    kind: "external",
    openAlexId,
    doi: normalizeCitationDoi(work.doi),
    title: work.title,
    authors: [...work.authors],
    journal: work.journal,
    year: work.year,
    abstract: work.abstract,
    keywords: work.keywords ? [...work.keywords] : undefined,
    volume: work.volume,
    issue: work.issue,
    pages: work.pages,
    issn: work.issn ? [...work.issn] : undefined,
    citedByCount: work.citedByCount,
    referencedByLibrary: false,
    citesLibrary,
    sourceUrl: work.sourceUrl,
    metadataSources: work.metadataSources
      ? [...work.metadataSources]
      : [openAlexId ? "openalex" : "crossref"],
    matchStatus: work.matchStatus ?? "verified",
    matchConfidence: work.matchConfidence ?? 100,
  };
}

function intersectionSize<T>(first: Set<T>, second: Set<T>): number {
  let count = 0;
  const [small, large] =
    first.size <= second.size ? [first, second] : [second, first];
  for (const value of small) {
    if (large.has(value)) count += 1;
  }
  return count;
}

function normalizeTitle(value: string): string {
  return normalizeSpace(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
