import { createHash } from "node:crypto";
import type {
  CitationMatchStatus,
  CitationMetadataSource,
  CitationTextQuality,
} from "../shared/contracts";
import {
  normalizeCitationDoi,
  type CitationWorkRecord,
} from "../shared/citationGraph";
import { CrossrefClient, type CrossrefWorkRecord } from "./crossref-client";
import type { OpenAlexClient } from "./openalex-client";

const MATCH_CONCURRENCY = 4;
const OPENALEX_MATCH_THRESHOLD = 58;
const CROSSREF_MATCH_THRESHOLD = 66;
const MATCH_MARGIN = 12;

interface ReferenceResolverOptions {
  paperId: string;
  citations: string[];
  knownWorks: CitationWorkRecord[];
  sourceDoi?: string;
  openAlex: OpenAlexClient;
  crossref: CrossrefClient;
}

interface CitationFacts {
  rawCitation: string;
  normalizedCitation: string;
  quality: CitationTextQuality;
  doi?: string;
  year?: number;
  volume?: string;
  firstPage?: string;
}

interface CrossrefCandidateChoice {
  citation: CitationFacts;
  work?: CrossrefWorkRecord;
  score: number;
  status: CitationMatchStatus;
}

export async function resolveReferenceWorks({
  paperId,
  citations,
  knownWorks,
  sourceDoi,
  openAlex,
  crossref,
}: ReferenceResolverOptions): Promise<CitationWorkRecord[]> {
  const sourceDoiNormalized = normalizeCitationDoi(sourceDoi);
  const facts = citations
    .map(createCitationFacts)
    .filter((citation) => citation.rawCitation);
  if (!facts.length) return [];

  const directDois = [
    ...new Set(
      facts
        .map((citation) => citation.doi)
        .filter((doi): doi is string =>
          Boolean(doi && doi !== sourceDoiNormalized),
        ),
    ),
  ];
  const directCrossref = new Map<string, CrossrefWorkRecord>();
  await mapWithConcurrency(directDois, MATCH_CONCURRENCY, async (doi) => {
    const work = await crossref.getWorkByDoi(doi);
    if (work) directCrossref.set(doi, work);
  });

  const directOpenAlex =
    directDois.length > 0
      ? await openAlex.getWorksByDois(directDois).catch(() => [])
      : [];
  const openAlexByDoi = new Map(
    [...knownWorks, ...directOpenAlex]
      .filter((work) => work.doi)
      .map((work) => [normalizeCitationDoi(work.doi)!, work]),
  );
  const availableKnownWorks = new Map(
    knownWorks.map((work) => [work.openAlexId, work]),
  );
  const resolved: Array<CitationWorkRecord | undefined> = [];
  const unresolvedForCrossref: CitationFacts[] = [];

  for (const citation of facts) {
    if (citation.doi && citation.doi !== sourceDoiNormalized) {
      const crossrefWork = directCrossref.get(citation.doi);
      const openAlexWork = openAlexByDoi.get(citation.doi);
      resolved.push(
        createDoiResolvedWork(
          paperId,
          resolved.length,
          citation,
          crossrefWork,
          openAlexWork,
        ),
      );
      if (openAlexWork) availableKnownWorks.delete(openAlexWork.openAlexId);
      continue;
    }

    const openAlexMatch = chooseOpenAlexCandidate(citation, [
      ...availableKnownWorks.values(),
    ]);
    if (openAlexMatch) {
      availableKnownWorks.delete(openAlexMatch.openAlexId);
      resolved.push(annotateOpenAlexMatch(citation, openAlexMatch, "probable"));
      continue;
    }
    unresolvedForCrossref.push(citation);
    resolved.push(undefined);
  }

  const crossrefChoices = await resolveCrossrefChoices(
    unresolvedForCrossref,
    crossref,
  );
  const crossrefDois = [
    ...new Set(
      crossrefChoices
        .map((choice) => choice.work?.doi)
        .filter((doi): doi is string => Boolean(doi)),
    ),
  ];
  const missingOpenAlexDois = crossrefDois.filter(
    (doi) => !openAlexByDoi.has(doi),
  );
  const crossrefOpenAlex =
    missingOpenAlexDois.length > 0
      ? await openAlex.getWorksByDois(missingOpenAlexDois).catch(() => [])
      : [];
  for (const work of crossrefOpenAlex) {
    if (work.doi) openAlexByDoi.set(normalizeCitationDoi(work.doi)!, work);
  }

  let choiceIndex = 0;
  for (let index = 0; index < facts.length; index += 1) {
    if (resolved[index]) continue;
    const choice = crossrefChoices[choiceIndex];
    choiceIndex += 1;
    if (!choice?.work) {
      resolved[index] = createPlaceholderWork(
        paperId,
        index,
        facts[index],
        choice?.status ?? "unresolved",
        choice?.score ?? 0,
      );
      continue;
    }
    const openAlexWork = choice.work.doi
      ? openAlexByDoi.get(choice.work.doi)
      : undefined;
    resolved[index] = mergeCrossrefCandidate(
      paperId,
      index,
      choice,
      openAlexWork,
    );
  }

  return resolved.filter((work): work is CitationWorkRecord => Boolean(work));
}

export function createCitationFacts(value: string): CitationFacts {
  const rawCitation = value.replace(/\s+/g, " ").trim();
  const quality: CitationTextQuality =
    /[\uFFFD\u25A1\u25A0]/u.test(rawCitation) ||
    rawCitation.includes("?") ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(rawCitation)
      ? "degraded"
      : "clean";
  const normalizedCitation = normalizeMatchText(
    rawCitation
      .normalize("NFKC")
      .replace(/\u00AD/g, "")
      .replace(/[\u2010-\u2015]/g, "-"),
  );
  const pageMatch = rawCitation.match(
    /(?:,|\s)(\d{1,6})(?:\s*[-–]\s*\d{1,6})?[.,;)]?\s*$/,
  );
  const numericParts = rawCitation.match(/\b\d{1,5}\b/g) ?? [];
  const year = extractCitationYear(rawCitation);
  const volume = year
    ? numericParts.find((part) => Number(part) !== year && Number(part) < 1000)
    : undefined;
  return {
    rawCitation,
    normalizedCitation,
    quality,
    doi: extractCitationDoi(rawCitation),
    year,
    volume,
    firstPage: pageMatch?.[1],
  };
}

async function resolveCrossrefChoices(
  citations: CitationFacts[],
  crossref: CrossrefClient,
): Promise<CrossrefCandidateChoice[]> {
  const choices = new Array<CrossrefCandidateChoice>(citations.length);
  await mapWithConcurrency(
    citations,
    MATCH_CONCURRENCY,
    async (citation, index) => {
      const candidates = await crossref.findWorksByBibliographic(
        citation.rawCitation,
      );
      const ranked = candidates
        .map((work) => ({
          work,
          score: scoreCitationAgainstMetadata(citation, work),
        }))
        .sort((left, right) => right.score - left.score);
      const best = ranked[0];
      const second = ranked[1];
      const strongDegradedMatch =
        citation.quality === "degraded" &&
        best &&
        best.score >= 60 &&
        hasStrongBibliographicFingerprint(citation, best.work);
      const accepted =
        best &&
        (best.score >= CROSSREF_MATCH_THRESHOLD || strongDegradedMatch) &&
        best.score - (second?.score ?? 0) >= MATCH_MARGIN;
      choices[index] = {
        citation,
        work: accepted ? best.work : undefined,
        score: best?.score ?? 0,
        status: accepted
          ? "probable"
          : ranked.length > 1
            ? "ambiguous"
            : "unresolved",
      };
    },
  );
  return choices;
}


function createDoiResolvedWork(
  paperId: string,
  index: number,
  citation: CitationFacts,
  crossrefWork?: CrossrefWorkRecord,
  openAlexWork?: CitationWorkRecord,
): CitationWorkRecord {
  const work = crossrefWork ?? openAlexWork;
  if (!work) {
    return createPlaceholderWork(paperId, index, citation, "unresolved", 0);
  }
  const metadataScore = scoreCitationAgainstMetadata(citation, work);
  const contradictsCitation =
    citation.year &&
    work.year &&
    Math.abs(citation.year - work.year) > 1 &&
    metadataScore < 35;
  if (contradictsCitation) {
    return createPlaceholderWork(
      paperId,
      index,
      citation,
      "ambiguous",
      metadataScore,
    );
  }
  return mergeMetadata(
    paperId,
    index,
    citation,
    crossrefWork,
    openAlexWork,
    "verified",
    100,
  );
}

function mergeCrossrefCandidate(
  paperId: string,
  index: number,
  choice: CrossrefCandidateChoice,
  openAlexWork?: CitationWorkRecord,
): CitationWorkRecord {
  const status: CitationMatchStatus =
    openAlexWork && choice.score >= 75 ? "verified" : "probable";
  const confidence = Math.min(
    99,
    Math.round(choice.score + (openAlexWork ? 10 : 0)),
  );
  return mergeMetadata(
    paperId,
    index,
    choice.citation,
    choice.work,
    openAlexWork,
    status,
    confidence,
  );
}

function annotateOpenAlexMatch(
  citation: CitationFacts,
  work: CitationWorkRecord,
  status: CitationMatchStatus,
): CitationWorkRecord {
  const confidence = scoreCitationAgainstMetadata(citation, work);
  return {
    ...work,
    authors: [...work.authors],
    referencedOpenAlexIds: [...work.referencedOpenAlexIds],
    metadataSources: mergeSources(work.metadataSources, ["pdf", "openalex"]),
    matchStatus: status,
    matchConfidence: confidence,
    rawCitation: citation.rawCitation,
    textQuality: citation.quality,
  };
}

function mergeMetadata(
  paperId: string,
  index: number,
  citation: CitationFacts,
  crossrefWork: CrossrefWorkRecord | undefined,
  openAlexWork: CitationWorkRecord | undefined,
  status: CitationMatchStatus,
  confidence: number,
): CitationWorkRecord {
  const sourceId =
    openAlexWork?.openAlexId ??
    `REF_${createHash("sha256")
      .update(
        `${paperId}\0${index}\0${crossrefWork?.doi ?? citation.rawCitation}`,
      )
      .digest("hex")
      .slice(0, 24)}`;
  return {
    openAlexId: sourceId,
    doi: crossrefWork?.doi ?? openAlexWork?.doi ?? citation.doi,
    title: crossrefWork?.title ?? openAlexWork?.title ?? "未解析参考文献",
    authors:
      crossrefWork && crossrefWork.authors.length > 0
        ? [...crossrefWork.authors]
        : [...(openAlexWork?.authors ?? [])],
    journal: crossrefWork?.journal ?? openAlexWork?.journal ?? "PDF 参考文献",
    year: crossrefWork?.year ?? openAlexWork?.year ?? citation.year,
    volume: crossrefWork?.volume ?? openAlexWork?.volume,
    issue: crossrefWork?.issue ?? openAlexWork?.issue,
    pages: crossrefWork?.pages ?? openAlexWork?.pages,
    issn: crossrefWork?.issn ?? openAlexWork?.issn,
    abstract: openAlexWork?.abstract,
    citedByCount: openAlexWork?.citedByCount,
    referencedOpenAlexIds: [...(openAlexWork?.referencedOpenAlexIds ?? [])],
    sourceUrl: crossrefWork?.sourceUrl ?? openAlexWork?.sourceUrl,
    metadataSources: mergeSources(openAlexWork?.metadataSources, [
      "pdf",
      ...(crossrefWork ? (["crossref"] as CitationMetadataSource[]) : []),
      ...(openAlexWork ? (["openalex"] as CitationMetadataSource[]) : []),
    ]),
    matchStatus: status,
    matchConfidence: confidence,
    rawCitation: citation.rawCitation,
    textQuality: citation.quality,
  };
}

function createPlaceholderWork(
  paperId: string,
  index: number,
  citation: CitationFacts,
  status: CitationMatchStatus,
  confidence: number,
): CitationWorkRecord {
  const openAlexId = `REF_${createHash("sha256")
    .update(`${paperId}\0${index}\0${citation.rawCitation}`)
    .digest("hex")
    .slice(0, 24)}`;
  return {
    openAlexId,
    title: "未解析参考文献",
    authors: [],
    journal: "PDF 参考文献",
    year: citation.year,
    citedByCount: undefined,
    referencedOpenAlexIds: [],
    metadataSources: ["pdf"],
    matchStatus: status,
    matchConfidence: confidence || undefined,
    rawCitation: citation.rawCitation,
    textQuality: citation.quality,
  };
}

function chooseOpenAlexCandidate(
  citation: CitationFacts,
  works: CitationWorkRecord[],
): CitationWorkRecord | undefined {
  const ranked = works
    .map((work) => ({
      work,
      score: scoreCitationAgainstMetadata(citation, work),
    }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const second = ranked[1];
  if (
    !best ||
    best.score < OPENALEX_MATCH_THRESHOLD ||
    best.score - (second?.score ?? 0) < MATCH_MARGIN
  ) {
    return undefined;
  }
  return best.work;
}

function scoreCitationAgainstMetadata(
  citation: CitationFacts,
  work: Pick<
    CitationWorkRecord | CrossrefWorkRecord,
    "title" | "authors" | "journal" | "year" | "volume" | "pages"
  >,
): number {
  const citationTokens = tokenSet(citation.normalizedCitation);
  let score = 0;
  if (citation.year && work.year) {
    const difference = Math.abs(citation.year - work.year);
    score += difference === 0 ? 18 : difference === 1 ? 10 : -16;
  }

  const firstAuthor = authorSurname(work.authors[0] ?? "");
  if (firstAuthor && citationTokens.has(firstAuthor)) score += 22;
  const otherAuthors = work.authors
    .slice(1)
    .map(authorSurname)
    .filter((author) => author.length >= 3);
  score += Math.min(
    12,
    otherAuthors.filter((author) => citationTokens.has(author)).length * 6,
  );

  const journalHits = countJournalMatches(citationTokens, work.journal ?? "");
  score += Math.min(18, journalHits * 6);

  if (citation.volume && work.volume === citation.volume) score += 12;
  const workFirstPage = work.pages?.match(/\d{1,6}/)?.[0];
  if (citation.firstPage && workFirstPage === citation.firstPage) score += 18;

  const titleTokens = [
    ...tokenSet(normalizeMatchText(work.title ?? "")),
  ].filter((token) => token.length >= 5);
  if (titleTokens.length > 0) {
    const titleHits = titleTokens.filter((token) => citationTokens.has(token));
    if (titleHits.length > 0) {
      score += Math.min(
        20,
        Math.round((titleHits.length / Math.min(titleTokens.length, 8)) * 20),
      );
    }
  }
  return Math.max(0, Math.min(100, score));
}

function hasStrongBibliographicFingerprint(
  citation: CitationFacts,
  work: CrossrefWorkRecord,
): boolean {
  const workFirstPage = work.pages?.match(/\d{1,6}/)?.[0];
  return Boolean(
    citation.year &&
    work.year === citation.year &&
    citation.volume &&
    work.volume === citation.volume &&
    citation.firstPage &&
    workFirstPage === citation.firstPage &&
    countJournalMatches(
      tokenSet(citation.normalizedCitation),
      work.journal ?? "",
    ) > 0,
  );
}

function countJournalMatches(
  citationTokens: Set<string>,
  journal: string,
): number {
  const journalTokens = tokenSet(normalizeMatchText(journal));
  return [...journalTokens].filter(
    (token) =>
      token.length >= 4 &&
      [...citationTokens].some(
        (citationToken) =>
          citationToken === token ||
          (citationToken.length >= 3 &&
            (citationToken.startsWith(token) ||
              token.startsWith(citationToken))),
      ),
  ).length;
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

function mergeSources(
  current: CitationMetadataSource[] | undefined,
  next: CitationMetadataSource[],
): CitationMetadataSource[] {
  const sources = new Set([...(current ?? []), ...next]);
  return (
    [
      "library",
      "pdf",
      "crossref",
      "openalex",
    ] as CitationMetadataSource[]
  ).filter((source) => sources.has(source));
}

function tokenSet(value: string): Set<string> {
  return new Set(value.split(" ").filter(Boolean));
}

function normalizeMatchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  handler: (value: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        await handler(values[index], index);
      }
    },
  );
  await Promise.all(workers);
}
