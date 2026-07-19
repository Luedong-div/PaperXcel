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
const AI_RETRY_MATCH_THRESHOLD = 70;

export interface CitationReferenceSearchRequest {
  id: string;
  rawCitation: string;
}

export interface CitationReferenceSearchHint {
  id: string;
  title?: string;
  authors?: string[];
  year?: number;
  doi?: string;
}

interface ReferenceResolverOptions {
  paperId: string;
  citations: string[];
  knownWorks: CitationWorkRecord[];
  sourceDoi?: string;
  openAlex: OpenAlexClient;
  crossref: CrossrefClient;
}

interface ReferenceRetryOptions {
  paperId: string;
  works: CitationWorkRecord[];
  sourceDoi?: string;
  openAlex: OpenAlexClient;
  crossref: CrossrefClient;
  extractSearchHints: (
    references: CitationReferenceSearchRequest[],
  ) => Promise<CitationReferenceSearchHint[]>;
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

interface ReferenceRetryCandidate {
  crossref?: CrossrefWorkRecord;
  openAlex?: CitationWorkRecord;
  score: number;
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

export async function retryUnresolvedReferenceWorksWithAi({
  paperId,
  works,
  sourceDoi,
  openAlex,
  crossref,
  extractSearchHints,
}: ReferenceRetryOptions): Promise<CitationWorkRecord[]> {
  const targets = works
    .map((work, index) => ({ work, index }))
    .filter(
      ({ work }) =>
        (work.matchStatus === "unresolved" ||
          work.matchStatus === "ambiguous") &&
        Boolean(work.rawCitation?.trim()),
    );
  if (!targets.length) return works;

  const requests = targets.map(({ work }) => ({
    id: work.openAlexId,
    rawCitation: work.rawCitation!.trim(),
  }));
  const allowedIds = new Set(requests.map((request) => request.id));
  let extractedHints: CitationReferenceSearchHint[];
  try {
    extractedHints = await extractSearchHints(requests);
  } catch {
    return works;
  }

  const hints = new Map<string, CitationReferenceSearchHint>();
  for (const hint of extractedHints) {
    const normalized = normalizeReferenceSearchHint(hint, allowedIds);
    if (normalized) hints.set(normalized.id, normalized);
  }
  if (!hints.size) return works;

  const replacements = new Map<string, CitationWorkRecord>();
  await mapWithConcurrency(
    targets,
    MATCH_CONCURRENCY,
    async ({ work, index }) => {
      const hint = hints.get(work.openAlexId);
      if (!hint) return;
      const replacement = await resolveReferenceSearchHint({
        paperId,
        index,
        original: work,
        hint,
        sourceDoi,
        openAlex,
        crossref,
      }).catch(() => undefined);
      if (replacement) replacements.set(work.openAlexId, replacement);
    },
  );

  return works.map((work) => replacements.get(work.openAlexId) ?? work);
}

export function createCitationFacts(value: string): CitationFacts {
  const rawCitation = value.replace(/\s+/g, " ").trim();
  const quality: CitationTextQuality =
    /[\uFFFD\u25A1\u25A0]/u.test(rawCitation) ||
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

async function resolveReferenceSearchHint({
  paperId,
  index,
  original,
  hint,
  sourceDoi,
  openAlex,
  crossref,
}: {
  paperId: string;
  index: number;
  original: CitationWorkRecord;
  hint: CitationReferenceSearchHint;
  sourceDoi?: string;
  openAlex: OpenAlexClient;
  crossref: CrossrefClient;
}): Promise<CitationWorkRecord | undefined> {
  const normalizedSourceDoi = normalizeCitationDoi(sourceDoi);
  const hintDoi = normalizeCitationDoi(hint.doi);
  if (hintDoi && hintDoi === normalizedSourceDoi) return undefined;

  const query = buildReferenceSearchQuery(hint);
  const [doiCrossref, doiOpenAlex, crossrefSearch, openAlexSearch] =
    await Promise.all([
      hintDoi
        ? crossref.getWorkByDoi(hintDoi).catch(() => undefined)
        : Promise.resolve(undefined),
      hintDoi
        ? openAlex.getWorkByDoi(hintDoi).catch(() => undefined)
        : Promise.resolve(undefined),
      query
        ? crossref.findWorksByBibliographic(query).catch(() => [])
        : Promise.resolve([]),
      query
        ? openAlex.findWorksBySearch(query).catch(() => [])
        : Promise.resolve([]),
    ]);

  const candidates = new Map<string, ReferenceRetryCandidate>();
  for (const work of [doiCrossref, ...crossrefSearch]) {
    if (!work) continue;
    const key = referenceCandidateKey(work);
    const candidate = candidates.get(key) ?? { score: 0 };
    candidate.crossref = work;
    candidates.set(key, candidate);
  }
  for (const work of [doiOpenAlex, ...openAlexSearch]) {
    if (!work) continue;
    const key = referenceCandidateKey(work);
    const candidate = candidates.get(key) ?? { score: 0 };
    candidate.openAlex = work;
    candidates.set(key, candidate);
  }

  const ranked = [...candidates.values()]
    .map((candidate) => ({
      ...candidate,
      score: scoreReferenceSearchHint(
        hint,
        candidate.crossref ?? candidate.openAlex!,
      ),
    }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const second = ranked[1];
  if (
    !best ||
    best.score < AI_RETRY_MATCH_THRESHOLD ||
    best.score - (second?.score ?? 0) < MATCH_MARGIN
  ) {
    return undefined;
  }

  const originalFacts = createCitationFacts(original.rawCitation ?? "");
  const citation: CitationFacts = {
    ...originalFacts,
    normalizedCitation: normalizeMatchText(
      [originalFacts.rawCitation, buildReferenceSearchQuery(hint)]
        .filter(Boolean)
        .join(" "),
    ),
    doi: hintDoi ?? originalFacts.doi,
    year: hint.year ?? originalFacts.year,
  };
  const status: CitationMatchStatus =
    best.crossref && best.openAlex && best.score >= 85
      ? "verified"
      : "probable";
  return mergeMetadata(
    paperId,
    index,
    citation,
    best.crossref,
    best.openAlex,
    status,
    best.score,
  );
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

function normalizeReferenceSearchHint(
  hint: CitationReferenceSearchHint,
  allowedIds: Set<string>,
): CitationReferenceSearchHint | undefined {
  const id = typeof hint.id === "string" ? hint.id.trim() : "";
  if (!allowedIds.has(id)) return undefined;
  const title =
    typeof hint.title === "string"
      ? hint.title.replace(/\s+/g, " ").trim().slice(0, 500)
      : undefined;
  const authors = Array.isArray(hint.authors)
    ? [
        ...new Set(
          hint.authors
            .filter((author): author is string => typeof author === "string")
            .map((author) => author.replace(/\s+/g, " ").trim().slice(0, 180))
            .filter(Boolean),
        ),
      ].slice(0, 20)
    : [];
  const year = Number(hint.year);
  const normalizedYear =
    Number.isInteger(year) &&
    year >= 1400 &&
    year <= new Date().getFullYear() + 1
      ? year
      : undefined;
  const doi = normalizeCitationDoi(hint.doi);
  if (!title && !doi) return undefined;
  return {
    id,
    title: title || undefined,
    authors: authors.length ? authors : undefined,
    year: normalizedYear,
    doi,
  };
}

function buildReferenceSearchQuery(hint: CitationReferenceSearchHint): string {
  return [
    hint.title,
    ...(hint.authors?.slice(0, 3) ?? []),
    hint.year ? String(hint.year) : "",
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 800);
}

function referenceCandidateKey(
  work: CitationWorkRecord | CrossrefWorkRecord,
): string {
  const doi = normalizeCitationDoi(work.doi);
  if (doi) return `doi:${doi}`;
  const title = normalizeMatchText(work.title ?? "");
  return title
    ? `title:${title}\0${work.year ?? ""}`
    : "openAlexId" in work
      ? `openalex:${work.openAlexId}`
      : `crossref:${JSON.stringify(work)}`;
}

function scoreReferenceSearchHint(
  hint: CitationReferenceSearchHint,
  work: CitationWorkRecord | CrossrefWorkRecord,
): number {
  const hintDoi = normalizeCitationDoi(hint.doi);
  const workDoi = normalizeCitationDoi(work.doi);
  if (hintDoi && workDoi === hintDoi) return 100;

  let score = 0;
  const hintTitleTokens = [
    ...tokenSet(normalizeMatchText(hint.title ?? "")),
  ].filter((token) => token.length >= 3);
  const workTitleTokens = [
    ...tokenSet(normalizeMatchText(work.title ?? "")),
  ].filter((token) => token.length >= 3);
  if (hintTitleTokens.length && workTitleTokens.length) {
    const workTokenSet = new Set(workTitleTokens);
    const hintTokenSet = new Set(hintTitleTokens);
    const overlap = hintTitleTokens.filter((token) =>
      workTokenSet.has(token),
    ).length;
    const recall = overlap / hintTitleTokens.length;
    const precision =
      workTitleTokens.filter((token) => hintTokenSet.has(token)).length /
      workTitleTokens.length;
    score += Math.round(recall * 65 + precision * 10);
  }

  const hintAuthors = (hint.authors ?? [])
    .map(authorSurname)
    .filter((author) => author.length >= 2);
  const workAuthors = new Set(
    work.authors.map(authorSurname).filter((author) => author.length >= 2),
  );
  if (hintAuthors[0] && workAuthors.has(hintAuthors[0])) score += 15;
  score += Math.min(
    10,
    hintAuthors.slice(1).filter((author) => workAuthors.has(author)).length * 5,
  );

  if (hint.year && work.year) {
    const difference = Math.abs(hint.year - work.year);
    score += difference === 0 ? 10 : difference === 1 ? 5 : -10;
  }
  return Math.max(0, Math.min(100, score));
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
