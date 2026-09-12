import { BrowserWindow, session } from "electron";
import type {
  CitationDiscoveryMode,
  CitationDiscoveryReason,
  CitationDiscoveryResult,
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
  buildCitationDiscoveryTerms,
  rankCitationDiscoveryCandidates,
} from "../shared/citationDiscovery";
import { buildGoogleScholarSearchUrl } from "../shared/externalSearch";
import type { OpenAlexClient } from "./openalex-client";

export const GOOGLE_SCHOLAR_SESSION_PARTITION =
  "persist:paperxcel-google-scholar";

interface RawScholarEntry {
  title?: string;
  sourceUrl?: string;
  authorsLine?: string;
  snippet?: string;
  citedByCount?: number;
  clusterId?: string;
}

export interface SearchGoogleScholarOptions {
  parent?: BrowserWindow;
  query: string;
  papers: Paper[];
  cache: CitationGraphCache;
  client: OpenAlexClient;
  mode: CitationDiscoveryMode;
  limit?: number;
  timeoutMs?: number;
}

export interface ImportGoogleScholarTextOptions extends Omit<
  SearchGoogleScholarOptions,
  "parent" | "timeoutMs"
> {
  text: string;
}

export async function importGoogleScholarText({
  text,
  query,
  papers,
  cache,
  client,
  mode,
  limit,
}: ImportGoogleScholarTextOptions): Promise<CitationDiscoveryResult> {
  const rawEntries = parseScholarCopiedText(text);
  return buildScholarDiscoveryResult({
    rawEntries,
    query,
    papers,
    cache,
    client,
    mode,
    limit,
    emptyWarning:
      "剪贴板中没有识别到 Scholar 论文标题。请在 Scholar 结果页使用 Ctrl+A、Ctrl+C 后重试。",
  });
}

export async function searchGoogleScholarInteractively({
  parent,
  query,
  papers,
  cache,
  client,
  mode,
  limit,
  timeoutMs = 5 * 60_000,
}: SearchGoogleScholarOptions): Promise<CitationDiscoveryResult> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) throw new Error("Google Scholar 搜索需要主题关键词。");

  const rawEntries = await collectScholarPage(
    normalizedQuery,
    parent,
    timeoutMs,
  );
  return buildScholarDiscoveryResult({
    rawEntries,
    query: normalizedQuery,
    papers,
    cache,
    client,
    mode,
    limit,
    emptyWarning:
      "Google Scholar 当前页面没有可导入结果；若出现人机验证，请完成验证后等待页面自动解析。",
  });
}

async function buildScholarDiscoveryResult({
  rawEntries,
  query,
  papers,
  cache,
  client,
  mode,
  limit,
  emptyWarning,
}: {
  rawEntries: RawScholarEntry[];
  query: string;
  papers: Paper[];
  cache: CitationGraphCache;
  client: OpenAlexClient;
  mode: CitationDiscoveryMode;
  limit?: number;
  emptyWarning: string;
}): Promise<CitationDiscoveryResult> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) throw new Error("Google Scholar 搜索需要主题关键词。");
  const warnings: string[] = rawEntries.length === 0 ? [emptyWarning] : [];
  const parsed = rawEntries
    .map(parseScholarEntry)
    .filter((work): work is CitationWorkRecord => Boolean(work));
  const enriched = await enrichScholarWorks(parsed, client, warnings);
  const maxCandidates =
    mode === "pure-search"
      ? CITATION_DISCOVERY_PURE_SEARCH_MAX_CANDIDATES
      : CITATION_DISCOVERY_MAX_CANDIDATES;
  const requestedLimit = Math.max(
    1,
    Math.min(maxCandidates, Math.ceil(limit ?? maxCandidates)),
  );
  const seedOpenAlexIds =
    mode === "pure-search"
      ? {}
      : Object.fromEntries(
          papers.map((paper) => [paper.id, cache.cores[paper.id]?.openAlexId]),
        );
  const seedReferences =
    mode === "pure-search"
      ? {}
      : Object.fromEntries(
          papers.map((paper) => [
            paper.id,
            cache.cores[paper.id]?.referencedOpenAlexIds ?? [],
          ]),
        );

  return {
    candidates: rankCitationDiscoveryCandidates({
      papers: mode === "pure-search" ? [] : papers,
      candidates: enriched.map((work) => ({
        work,
        reasons: ["topic-match" as CitationDiscoveryReason],
      })),
      query: normalizedQuery,
      seedOpenAlexIds,
      seedReferences,
      limit: requestedLimit,
      maxCandidates,
    }),
    query: normalizedQuery,
    terms: buildCitationDiscoveryTerms(
      mode === "pure-search" ? [] : papers,
      normalizedQuery,
    ),
    searchedAt: new Date().toISOString(),
    warnings,
    mode,
  };
}

export function parseScholarCopiedText(text: string): RawScholarEntry[] {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const entries: RawScholarEntry[] = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const title = cleanScholarTitle(lines[index]);
    const authorsLine = lines[index + 1];
    if (
      title.length < 8 ||
      title.length > 500 ||
      !/\b(?:19|20)\d{2}\b/.test(authorsLine) ||
      !/\s[-–—]\s/.test(authorsLine) ||
      /^(Cited by|Related articles|All \d+ versions|被引用次数)/i.test(title)
    ) {
      continue;
    }
    const nearby = lines.slice(index + 2, index + 7);
    const citedLine = nearby.find((line) =>
      /^(?:Cited by|被引用次数)\s*\d+/i.test(line),
    );
    const snippet = nearby.find(
      (line) =>
        line.length > 40 &&
        !/^(?:Cited by|Related articles|All \d+ versions|Save|保存)/i.test(
          line,
        ),
    );
    entries.push({
      title,
      authorsLine,
      snippet,
      citedByCount: citedLine ? Number(citedLine.match(/\d+/)?.[0]) : undefined,
    });
    index += 1;
  }
  return entries;
}

async function collectScholarPage(
  query: string,
  parent: BrowserWindow | undefined,
  timeoutMs: number,
): Promise<RawScholarEntry[]> {
  const scholarSession = session.fromPartition(
    GOOGLE_SCHOLAR_SESSION_PARTITION,
  );
  return new Promise((resolve) => {
    let settled = false;
    let inspectionRunning = false;
    const collected = new Map<string, RawScholarEntry>();
    const browser = new BrowserWindow({
      parent,
      width: 1120,
      height: 820,
      minWidth: 780,
      minHeight: 560,
      show: true,
      autoHideMenuBar: true,
      title: "PaperXcel - Google Scholar 交互式检索",
      backgroundColor: "#ffffff",
      webPreferences: {
        session: scholarSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const timer = setTimeout(
      () => finish([...collected.values()], true),
      timeoutMs,
    );
    const finish = (entries: RawScholarEntry[], closeWindow: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(pollTimer);
      resolve(entries);
      if (browser.isDestroyed()) return;
      if (closeWindow) {
        browser.close();
        return;
      }
      browser.setTitle(
        `PaperXcel - Google Scholar（已导入 ${entries.length} 条，可继续浏览或关闭）`,
      );
    };
    const inspect = async (): Promise<void> => {
      if (
        settled ||
        inspectionRunning ||
        browser.isDestroyed() ||
        browser.webContents.isLoading()
      ) {
        return;
      }
      inspectionRunning = true;
      try {
        const entries = (await browser.webContents.executeJavaScript(
          `(() => Array.from(document.querySelectorAll(".gs_r.gs_or.gs_scl")).map((row) => {
            const titleLink = row.querySelector(".gs_rt a");
            const meta = row.querySelector(".gs_a");
            const snippet = row.querySelector(".gs_rs");
            const links = Array.from(row.querySelectorAll(".gs_fl a"));
            const cited = links.find((link) => /^(Cited by|被引用次数)/i.test((link.textContent || "").trim()));
            const versions = links.find((link) => /^(All \\d+ versions|所有 \\d+ 个版本)/i.test((link.textContent || "").trim()));
            const citedText = (cited && cited.textContent) || "";
            const clusterUrl = (versions && versions.href) || (cited && cited.href) || "";
            return {
              title: (titleLink?.textContent || row.querySelector(".gs_rt")?.textContent || "").trim(),
              sourceUrl: titleLink?.href || "",
              authorsLine: (meta?.textContent || "").trim(),
              snippet: (snippet?.textContent || "").trim(),
              citedByCount: Number((citedText.match(/\\d+/) || [])[0]) || undefined,
              clusterId: (clusterUrl.match(/[?&](?:cluster|cites)=([^&]+)/) || [])[1]
            };
          }).filter((entry) => entry.title))()`,
          true,
        )) as RawScholarEntry[];
        if (Array.isArray(entries) && entries.length > 0) {
          for (const entry of entries) {
            const key =
              entry.clusterId?.trim() ||
              entry.sourceUrl?.trim() ||
              cleanScholarTitle(entry.title).toLocaleLowerCase();
            if (key) collected.set(key, entry);
          }
          browser.setTitle(
            `PaperXcel - Google Scholar（已采集 ${collected.size} 条；可继续翻页，关闭窗口后导入）`,
          );
        }
      } catch {
        // CAPTCHA/consent/navigation pages are intentionally left open.
      } finally {
        inspectionRunning = false;
      }
    };

    browser.on("closed", () => finish([...collected.values()], false));
    browser.webContents.on("did-finish-load", () => void inspect());
    browser.webContents.on("did-navigate-in-page", () => void inspect());
    browser.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void browser.loadURL(url);
      return { action: "deny" };
    });
    const pollTimer = setInterval(() => void inspect(), 1200);
    void browser.loadURL(buildGoogleScholarSearchUrl(query)).catch(() => {
      finish([], true);
    });
  });
}

function parseScholarEntry(
  entry: RawScholarEntry,
): CitationWorkRecord | undefined {
  const title = cleanScholarTitle(entry.title);
  if (!title) return undefined;
  const doi = extractDoi(
    `${entry.sourceUrl ?? ""} ${entry.snippet ?? ""} ${entry.authorsLine ?? ""}`,
  );
  const year = extractYear(entry.authorsLine);
  const authors = extractAuthors(entry.authorsLine);
  const clusterId = entry.clusterId?.trim();
  return {
    openAlexId: clusterId
      ? `scholar:${clusterId}`
      : `scholar:${stableTextId(title)}`,
    doi,
    title,
    authors,
    journal: extractVenue(entry.authorsLine),
    year,
    abstract: entry.snippet?.trim() || undefined,
    citedByCount: entry.citedByCount,
    referencedOpenAlexIds: [],
    sourceUrl: entry.sourceUrl,
    metadataSources: ["google-scholar"],
    matchStatus: doi ? "probable" : "ambiguous",
    matchConfidence: doi ? 85 : 65,
  };
}

async function enrichScholarWorks(
  works: CitationWorkRecord[],
  client: OpenAlexClient,
  warnings: string[],
): Promise<CitationWorkRecord[]> {
  const output: CitationWorkRecord[] = [];
  for (const work of works) {
    try {
      const matched = work.doi
        ? await client.getWorkByDoi(work.doi)
        : (
            await client.findWorksBySearch(
              [work.title, work.authors[0], work.year]
                .filter(Boolean)
                .join(" "),
              5,
            )
          ).find((candidate) => titlesLikelyMatch(work.title, candidate.title));
      if (matched) {
        output.push({
          ...work,
          ...matched,
          citedByCount: matched.citedByCount ?? work.citedByCount,
          abstract: matched.abstract ?? work.abstract,
          sourceUrl: work.sourceUrl ?? matched.sourceUrl,
          metadataSources: [
            ...new Set([
              ...(work.metadataSources ?? []),
              ...(matched.metadataSources ?? []),
            ]),
          ],
          matchStatus: "verified",
          matchConfidence: work.doi ? 100 : 92,
        });
        continue;
      }
    } catch (error) {
      warnings.push(
        `Scholar 结果“${work.title.slice(0, 48)}”未能通过 OpenAlex 补全：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    output.push(work);
  }
  return output;
}

function cleanScholarTitle(value?: string): string {
  return (value ?? "")
    .replace(/^\s*\[(?:PDF|HTML|BOOK|CITATION)\]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractDoi(value: string): string | undefined {
  return normalizeCitationDoi(
    value.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i)?.[0],
  );
}

function extractYear(value?: string): number | undefined {
  const years = (value ?? "").match(/\b(?:19|20)\d{2}\b/g);
  const year = years?.length ? Number(years.at(-1)) : NaN;
  return Number.isFinite(year) ? year : undefined;
}

function extractAuthors(value?: string): string[] {
  const firstPart = (value ?? "").split(/\s+-\s+/)[0] ?? "";
  return firstPart
    .split(/,\s*/)
    .map((author) => author.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function extractVenue(value?: string): string | undefined {
  const parts = (value ?? "").split(/\s+-\s+/);
  return parts.length > 1 ? parts[1]?.trim() || undefined : undefined;
}

function stableTextId(value: string): string {
  let hash = 2166136261;
  for (const character of value.normalize("NFKC").toLocaleLowerCase()) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function titlesLikelyMatch(first: string, second: string): boolean {
  const normalize = (value: string): Set<string> =>
    new Set(
      value
        .normalize("NFKC")
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}]{2,}/gu) ?? [],
    );
  const firstTokens = normalize(first);
  const secondTokens = normalize(second);
  if (!firstTokens.size || !secondTokens.size) return false;
  let shared = 0;
  for (const token of firstTokens) if (secondTokens.has(token)) shared += 1;
  return (2 * shared) / (firstTokens.size + secondTokens.size) >= 0.88;
}
