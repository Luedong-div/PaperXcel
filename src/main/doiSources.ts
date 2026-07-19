import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { PaperIdentifier, PaperMetadata } from "../shared/contracts";

export interface PdfCandidate {
  url: string;
  source: string;
  sessionPartition?: string;
  referer?: string;
}

export interface CrossrefMessageWithLinks {
  link?: Array<{
    URL?: string;
    "content-type"?: string;
    "content-version"?: string;
    "intended-application"?: string;
  }>;
}

export interface OpenAlexLocation {
  pdf_url?: string | null;
}

export interface OpenAlexWork {
  open_access?: {
    oa_url?: string | null;
  } | null;
  best_oa_location?: OpenAlexLocation | null;
  primary_location?: OpenAlexLocation | null;
  locations?: Array<OpenAlexLocation | null>;
}

export interface EuropePmcFullTextUrl {
  url?: string;
  documentStyle?: string;
  availability?: string;
  site?: string;
}

export interface EuropePmcResponse {
  resultList?: {
    result?: Array<{
      pmcid?: string;
      fullTextUrlList?: {
        fullTextUrl?: EuropePmcFullTextUrl[];
      };
    }>;
  };
}

export interface CoreWork {
  downloadUrl?: string | null;
  fullTextIdentifier?: string | null;
  links?: Array<{
    url?: string | null;
    type?: string | null;
  } | null>;
}

export interface CoreSearchResponse {
  results?: Array<CoreWork | null>;
}

export const DOI_AUTO_FETCH_CUTOFF_YEAR = 2022;

export function normalizeDoiInput(value: string): string {
  const trimmed = decodeInput(value.trim());
  const isDoiUrl = /^https?:\/\/(?:dx\.)?doi\.org\//i.test(trimmed);
  const isChemrxivUrl =
    /^https?:\/\/(?:www\.)?chemrxiv\.org\/doi\/(?:(?:full|pdf)\/)?/i.test(
      trimmed,
    );
  const withoutPrefix = trimmed
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(
      /^https?:\/\/(?:www\.)?chemrxiv\.org\/doi\/(?:(?:full|pdf)\/)?/i,
      "",
    );
  const doi =
    isDoiUrl || isChemrxivUrl
      ? withoutPrefix.replace(/[?#].*$/, "").replace(/\/+$/, "")
      : withoutPrefix;
  if (!/^10\.\d{4,9}\/\S+$/i.test(doi)) throw new Error("DOI 格式不正确。");
  return doi;
}

const NEW_ARXIV_ID = /^\d{4}\.\d{4,5}(?:v(\d+))?$/i;
const OLD_ARXIV_ID = /^[a-z][a-z0-9.-]*\/\d{7}(?:v(\d+))?$/i;
const ARXIV_REPOSITORY_DOI = /^10\.48550\/arxiv\.(.+)$/i;

function decodeInput(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeArxivInput(
  value: string,
): Extract<PaperIdentifier, { kind: "arxiv" }> {
  let candidate = decodeInput(value.trim());
  const repositoryDoi = candidate
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .match(ARXIV_REPOSITORY_DOI);
  if (repositoryDoi?.[1]) candidate = repositoryDoi[1];

  candidate = candidate
    .replace(/^arxiv:\s*/i, "")
    .replace(/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/[?#].*$/, "")
    .replace(/\.pdf$/i, "")
    .replace(/\/+$/, "");

  const match = candidate.match(NEW_ARXIV_ID) ?? candidate.match(OLD_ARXIV_ID);
  if (!match) {
    throw new Error("无法识别论文标识符，请输入 DOI 等相关信息。");
  }
  const version = match[1] ? Number(match[1]) : undefined;
  return {
    kind: "arxiv",
    arxivId: candidate.replace(/v\d+$/i, ""),
    version,
  };
}

export function parsePaperIdentifier(value: string): PaperIdentifier {
  const input = value.trim();
  if (!input) {
    throw new Error("请输入 DOI 等相关信息");
  }

  const withoutDoiUrl = decodeInput(input).replace(
    /^https?:\/\/(?:dx\.)?doi\.org\//i,
    "",
  );
  if (
    ARXIV_REPOSITORY_DOI.test(withoutDoiUrl) ||
    /^arxiv:/i.test(input) ||
    /^(?:https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\/)/i.test(input) ||
    NEW_ARXIV_ID.test(input) ||
    OLD_ARXIV_ID.test(input)
  ) {
    return normalizeArxivInput(input);
  }

  try {
    return { kind: "doi", doi: normalizeDoiInput(input) };
  } catch {
    throw new Error("无法识别论文标识符。请输入 DOI 等相关信息。");
  }
}

interface ArxivAtomAuthor {
  name?: string;
}

interface ArxivAtomLink {
  href?: string;
  rel?: string;
  type?: string;
  title?: string;
}

interface ArxivAtomEntry {
  id?: string;
  title?: string;
  summary?: string;
  published?: string;
  updated?: string;
  author?: ArxivAtomAuthor | ArxivAtomAuthor[];
  link?: ArxivAtomLink | ArxivAtomLink[];
  doi?: string;
  journal_ref?: string;
}

interface ArxivAtomFeed {
  feed?: {
    entry?: ArxivAtomEntry | ArxivAtomEntry[];
  };
}

export interface ArxivLookupResult {
  metadata: PaperMetadata;
  pdfCandidates: PdfCandidate[];
}

export interface CrossrefPreprintWork {
  DOI?: string;
  title?: string[];
  author?: Array<{
    given?: string;
    family?: string;
    name?: string;
  }>;
  published?: { "date-parts"?: number[][] };
  created?: { "date-parts"?: number[][] };
}

function asArray<T>(value?: T | T[]): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeAtomText(value?: string): string | undefined {
  return value?.replace(/\s+/g, " ").trim() || undefined;
}

function publisherDoi(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const doi = normalizeDoiInput(value);
    return ARXIV_REPOSITORY_DOI.test(doi) ? undefined : doi;
  } catch {
    return undefined;
  }
}

export function parseArxivAtomFeed(
  atom: string,
): ArxivLookupResult | undefined {
  return parseArxivAtomEntries(atom)[0];
}

export function parseArxivAtomEntries(atom: string): ArxivLookupResult[] {
  if (XMLValidator.validate(atom) !== true) {
    throw new Error("arXiv 返回了无法解析的数据。");
  }
  let parsed: ArxivAtomFeed;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      removeNSPrefix: true,
      parseTagValue: false,
      trimValues: true,
    }).parse(atom) as ArxivAtomFeed;
  } catch {
    throw new Error("arXiv 返回了无法解析的数据。");
  }

  return asArray(parsed.feed?.entry).flatMap(parseArxivAtomEntry);
}

function parseArxivAtomEntry(entry: ArxivAtomEntry): ArxivLookupResult[] {
  if (!entry.id || /arxiv\.org\/api\/errors#/i.test(entry.id)) return [];

  const identifier = normalizeArxivInput(entry.id);
  const resolvedVersionMatch = entry.id.match(/v(\d+)(?:[/?#]|$)/i);
  const resolvedVersion = resolvedVersionMatch?.[1]
    ? Number(resolvedVersionMatch[1])
    : identifier.version;
  const authors = asArray(entry.author)
    .map((author) => normalizeAtomText(author.name))
    .filter((name): name is string => Boolean(name));
  const links = asArray(entry.link);
  const pdfLinks = links
    .filter(
      (link) =>
        link.title?.toLowerCase() === "pdf" ||
        link.type?.toLowerCase() === "application/pdf" ||
        link.href?.includes("/pdf/"),
    )
    .map((link) => ({ url: link.href ?? "", source: "arXiv" }));
  const exactArxivId = `${identifier.arxivId}${
    resolvedVersion ? `v${resolvedVersion}` : ""
  }`;
  const submittedYear = Number(entry.published?.slice(0, 4));

  return [
    {
      metadata: {
        title: normalizeAtomText(entry.title) || identifier.arxivId,
        authors,
        journal: normalizeAtomText(entry.journal_ref),
        year: Number.isFinite(submittedYear) ? submittedYear : undefined,
        doi: publisherDoi(normalizeAtomText(entry.doi)),
        arxivId: identifier.arxivId,
        arxivVersion: resolvedVersion,
        abstract: normalizeAtomText(entry.summary),
        sourceUrl: `https://arxiv.org/abs/${exactArxivId}`,
      },
      pdfCandidates: uniquePdfCandidates([
        ...pdfLinks,
        {
          url: `https://arxiv.org/pdf/${exactArxivId}.pdf`,
          source: "arXiv",
        },
      ]),
    },
  ];
}

export function shouldAttemptOpenAccessPdf(year?: number): boolean {
  void year;
  return true;
}

export function extractDoiResolverPdfCandidates(doi: string): PdfCandidate[] {
  try {
    return [
      {
        url: `https://doi.org/${normalizeDoiInput(doi)}`,
        source: "DOI resolver",
      },
    ];
  } catch {
    return [];
  }
}

export function extractCrossrefPdfCandidates(
  message: CrossrefMessageWithLinks,
): PdfCandidate[] {
  return uniquePdfCandidates(
    (message.link ?? [])
      .filter((link) => {
        const contentType = link["content-type"]?.toLowerCase() ?? "";
        return contentType.includes("pdf") || looksLikePdfUrl(link.URL);
      })
      .map((link) => ({
        url: link.URL ?? "",
        source: "Crossref",
      })),
  );
}

export function extractChemrxivPdfCandidates(doi: string): PdfCandidate[] {
  let normalizedDoi: string;
  try {
    normalizedDoi = normalizeDoiInput(doi);
  } catch {
    return [];
  }

  if (!isChemrxivDoi(normalizedDoi)) {
    return [];
  }

  return uniquePdfCandidates([
    {
      url: `https://chemrxiv.org/doi/pdf/${encodeURIComponent(
        normalizedDoi,
      ).replace("%2F", "/")}`,
      source: "ChemRxiv",
    },
  ]);
}

export function isChemrxivDoi(value: string): boolean {
  try {
    return /^10\.26434\/chemrxiv(?:[-.]\S+)?$/i.test(normalizeDoiInput(value));
  } catch {
    return false;
  }
}

export function extractMatchingChemrxivPdfCandidates(
  metadata: Pick<PaperMetadata, "title" | "authors" | "year">,
  works: CrossrefPreprintWork[],
): PdfCandidate[] {
  const matches = works
    .flatMap((work) => {
      const doi = work.DOI?.trim();
      const title = work.title?.find((value) => value.trim())?.trim();
      if (!doi || !title || !isChemrxivDoi(doi)) return [];
      const score = titleMatchScore(metadata.title, title);
      const authorMatch = authorsOverlap(
        metadata.authors,
        (work.author ?? []).map((author) =>
          author.name?.trim()
            ? author.name.trim()
            : [author.given, author.family].filter(Boolean).join(" ").trim(),
        ),
      );
      const year =
        work.published?.["date-parts"]?.[0]?.[0] ??
        work.created?.["date-parts"]?.[0]?.[0];
      if (
        score < 0.9 &&
        !(score >= 0.82 && authorMatch) &&
        normalizeMatchText(metadata.title) !== normalizeMatchText(title)
      ) {
        return [];
      }
      if (
        metadata.year &&
        typeof year === "number" &&
        year > metadata.year + 1
      ) {
        return [];
      }
      return [{ doi, score, version: chemrxivVersion(doi) }];
    })
    .sort(
      (left, right) => right.score - left.score || right.version - left.version,
    );

  return uniquePdfCandidates(
    matches.flatMap(({ doi }) => extractChemrxivPdfCandidates(doi)),
  );
}

export function findMatchingArxivResult(
  metadata: Pick<PaperMetadata, "title" | "authors" | "year">,
  results: ArxivLookupResult[],
): ArxivLookupResult | undefined {
  const matches = results
    .map((result) => ({
      result,
      score: titleMatchScore(metadata.title, result.metadata.title),
      authorMatch: authorsOverlap(metadata.authors, result.metadata.authors),
    }))
    .filter(
      ({ result, score, authorMatch }) =>
        (score >= 0.9 || (score >= 0.82 && authorMatch)) &&
        !(
          metadata.year &&
          result.metadata.year &&
          result.metadata.year > metadata.year + 1
        ),
    )
    .sort((left, right) => right.score - left.score);
  return matches[0]?.result;
}

export function extractOpenAlexPdfCandidates(
  payload: OpenAlexWork,
): PdfCandidate[] {
  const locations = [
    payload.best_oa_location,
    payload.primary_location,
    ...(payload.locations ?? []),
  ].filter(Boolean);
  return uniquePdfCandidates([
    ...locations.map((location) => ({
      url: location?.pdf_url ?? "",
      source: "OpenAlex",
    })),
    {
      url: payload.open_access?.oa_url ?? "",
      source: "OpenAlex",
    },
  ]);
}

export function extractEuropePmcPdfCandidates(
  payload: EuropePmcResponse,
): PdfCandidate[] {
  const results = payload.resultList?.result ?? [];
  return uniquePdfCandidates(
    results.flatMap((result) => [
      ...(result.fullTextUrlList?.fullTextUrl ?? []).map((item) => ({
        url: item.url ?? "",
        source: "Europe PMC",
      })),
      {
        url: result.pmcid
          ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${result.pmcid}/pdf/`
          : "",
        source: "Europe PMC",
      },
    ]),
  );
}

export function extractArxivPdfCandidates(atom: string): PdfCandidate[] {
  return uniquePdfCandidates(
    [
      ...atom.matchAll(
        /<id>\s*https?:\/\/arxiv\.org\/abs\/([^<\s]+)\s*<\/id>/gi,
      ),
    ]
      .map((match) => match[1]?.trim().replace(/v\d+$/i, "") ?? "")
      .filter((id) => /^(?:[a-z-]+\/\d{7}|\d{4}\.\d{4,5})$/i.test(id))
      .map((id) => ({
        url: `https://arxiv.org/pdf/${id}.pdf`,
        source: "arXiv",
      })),
  );
}

export function extractCorePdfCandidates(
  payload: CoreSearchResponse,
): PdfCandidate[] {
  return uniquePdfCandidates(
    (payload.results ?? []).flatMap((work) => {
      if (!work) return [];
      return [
        { url: work.downloadUrl ?? "", source: "CORE" },
        { url: work.fullTextIdentifier ?? "", source: "CORE" },
        ...(work.links ?? []).map((link) => ({
          url: link?.url ?? "",
          source: "CORE",
        })),
      ];
    }),
  );
}

export const DEFAULT_SCIHUB_MIRRORS = [
  "https://sci-hub.se",
  "https://sci-hub.red",
  "https://sci-hub.st",
  "https://sci-hub.su",
  "https://sci-hub.ru",
  "https://sci-hub.box",
];

const SCIHUB_BLOCK_TOKENS = [
  "scientific mutual aid community",
  "you can request this article",
  "no matching proxies found",
  "please try searching the corresponding doi again",
  "just a moment",
  "access denied",
  "forbidden",
  "checking your browser",
  "security verification",
  "enable javascript and cookies to continue",
  "window._cf_chl_opt",
  "/cdn-cgi/challenge-platform/",
  "cf-ray",
  "cloudflare",
  "are you are robot",
  "are you a robot",
  "verify you are human",
  "human verification",
  "cf-turnstile",
  "cf-turnstile-response",
  "hcaptcha",
  "g-recaptcha",
  "recaptcha",
  "challenge-form",
  "captcha",
  "你是机器人吗",
  "不是机器人",
];

export function formatDoiForSciHub(doi: string): string {
  const replaced = doi.replace("/", "@");
  return encodeURIComponent(replaced)
    .replace(/%40/g, "@")
    .replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}

export function buildScihubPageUrls(mirror: string, doi: string): string[] {
  const base = mirror.replace(/\/+$/, "");
  const seen = new Set<string>();
  return [
    `${base}/${encodeURIComponent(doi)}`,
    `${base}/${doi}`,
    `${base}/${formatDoiForSciHub(doi)}`,
  ].filter((url) => (seen.has(url) ? false : (seen.add(url), true)));
}

// 检测页面是否为 Sci-Hub 的阻断页 / Cloudflare 挑战页。
export function looksLikeScihubBlock(html: string): boolean {
  const lower = html.toLowerCase();
  return SCIHUB_BLOCK_TOKENS.some((token) => lower.includes(token));
}

export function isLikelyScihubChallenge(status: number, html: string): boolean {
  return [403, 429, 503].includes(status) || looksLikeScihubBlock(html);
}

export function looksLikePdfNetworkResponse(
  url: string,
  responseHeaders?: Record<string, string[]>,
): boolean {
  const header = (name: string): string =>
    Object.entries(responseHeaders ?? {})
      .filter(([key]) => key.toLowerCase() === name)
      .flatMap(([, values]) => values)
      .join("; ")
      .toLowerCase();
  return (
    header("content-type").includes("pdf") ||
    /\.pdf(?:["';\s]|$)/i.test(header("content-disposition")) ||
    looksLikePdfUrl(url)
  );
}

export function extractScihubPdfCandidates(
  html: string,
  base: string,
): PdfCandidate[] {
  if (!html || looksLikeScihubBlock(html)) return [];

  const hrefs: string[] = [];
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\bname\s*=\s*["']citation_pdf_url["']/i.test(tag)) continue;
    const content = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1];
    if (content) hrefs.push(content);
  }
  for (const match of html.matchAll(
    /<(?:iframe|embed)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
  )) {
    hrefs.push(match[1]);
  }
  for (const match of html.matchAll(
    /location\.href\s*=\s*['"]([^'"]+)['"]/gi,
  )) {
    hrefs.push(match[1]);
  }
  for (const match of html.matchAll(
    /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi,
  )) {
    if (/\/downloads\/|\.pdf(?:[?#]|$)/i.test(match[1])) hrefs.push(match[1]);
  }

  return uniquePdfCandidates(
    hrefs.map((href) => ({
      url: resolveScihubUrl(base, href.trim()),
      source: "Sci-Hub",
    })),
  );
}

function resolveScihubUrl(base: string, maybeRelative: string): string {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return maybeRelative;
  }
}

function titleMatchScore(left: string, right: string): number {
  const normalizedLeft = normalizeMatchText(left);
  const normalizedRight = normalizeMatchText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;

  const leftTokens = new Set(normalizedLeft.split(" "));
  const rightTokens = new Set(normalizedRight.split(" "));
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  return (2 * shared) / (leftTokens.size + rightTokens.size);
}

function authorsOverlap(left: string[], right: string[]): boolean {
  const leftNames = new Set(left.map(authorFamilyName).filter(Boolean));
  return right
    .map(authorFamilyName)
    .filter(Boolean)
    .some((name) => leftNames.has(name));
}

function authorFamilyName(value: string): string {
  return normalizeMatchText(value).split(" ").filter(Boolean).at(-1) ?? "";
}

function normalizeMatchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chemrxivVersion(doi: string): number {
  const match = doi.match(/[.-]v(\d+)$/i);
  return match?.[1] ? Number(match[1]) : 0;
}

export function uniquePdfCandidates(
  candidates: PdfCandidate[],
): PdfCandidate[] {
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const url = sanitizeCandidateUrl(candidate.url);
    if (!url) return [];
    const key = url.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...candidate, url }];
  });
}

export async function resolvePdfCandidatesInOrder<T>(
  sources: Array<() => Promise<PdfCandidate[]>>,
  download: (candidate: PdfCandidate) => Promise<T | undefined>,
): Promise<T | undefined> {
  for (const loadCandidates of sources) {
    let candidates: PdfCandidate[];
    try {
      candidates = await loadCandidates();
    } catch {
      continue;
    }

    for (const candidate of candidates) {
      const downloaded = await download(candidate);
      if (downloaded !== undefined) return downloaded;
    }
  }

  return undefined;
}

function sanitizeCandidateUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function looksLikePdfUrl(value?: string): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return (
    /\/pdf(?:\/|$|[?#])/i.test(normalized) ||
    normalized.split("?")[0].endsWith(".pdf")
  );
}
