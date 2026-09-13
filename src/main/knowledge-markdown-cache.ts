import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderProtocol } from "../shared/contracts";
import { writeCancellableUtf8 } from "./cancellable-file";
import { filterPaperMarkdownContent } from "../shared/paperMarkdownContent";

export interface KnowledgeMarkdownRepairCache {
  sourceMode?: "pdf-rebuild";
  version: 2;
  paperId: string;
  source: {
    size: number;
    mtimeMs: number;
  };
  markdown: string;
  pageCount: number;
  model: string;
  protocol?: Exclude<ProviderProtocol, "auto">;
  repairedAt: string;
  warnings: string[];
  repairReport?: {
    batchCount: number;
    repairedBatchCount: number;
    preservedBatchCount: number;
    detectedIssues: string[];
  };
}

interface WriteKnowledgeMarkdownRepairCacheInput {
  sourceMode?: "pdf-rebuild";
  markdown: string;
  pageCount: number;
  model: string;
  protocol?: Exclude<ProviderProtocol, "auto">;
  repairedAt?: string;
  warnings: string[];
  repairReport?: KnowledgeMarkdownRepairCache["repairReport"];
}

export async function readKnowledgeMarkdownRepairCache(
  paperDirectory: string,
  paperId: string,
  pdfPath: string,
  legacyCacheRoot?: string,
  signal?: AbortSignal,
): Promise<KnowledgeMarkdownRepairCache | null> {
  signal?.throwIfAborted();
  const cachePath = knowledgeMarkdownRepairCachePath(paperDirectory);
  const legacyCachePath = legacyCacheRoot
    ? legacyKnowledgeMarkdownRepairCachePath(legacyCacheRoot, paperId)
    : undefined;
  const sourceInfo = await stat(pdfPath);
  signal?.throwIfAborted();
  for (const candidatePath of [cachePath, legacyCachePath]) {
    if (!candidatePath) continue;
    try {
      const serialized = await readFile(candidatePath, {
        encoding: "utf8",
        signal,
      });
      signal?.throwIfAborted();
      const cache = parseKnowledgeMarkdownRepairCache(serialized);
      if (
        !cache ||
        cache.paperId !== paperId ||
        cache.source.size !== sourceInfo.size ||
        cache.source.mtimeMs !== sourceInfo.mtimeMs
      ) {
        await rm(candidatePath, { force: true });
        continue;
      }
      const filteredMarkdown =
        cache.sourceMode === "pdf-rebuild"
          ? normalizeMarkdown(filterPaperMarkdownContent(cache.markdown))
          : cache.markdown;
      const contentChanged = filteredMarkdown !== cache.markdown;
      cache.markdown = filteredMarkdown;
      if (candidatePath !== cachePath || contentChanged) {
        await mkdir(paperDirectory, { recursive: true });
        signal?.throwIfAborted();
        await writeCancellableUtf8(
          cachePath,
          `${JSON.stringify(cache, null, 2)}\n`,
          signal ?? new AbortController().signal,
        );
        signal?.throwIfAborted();
        if (candidatePath !== cachePath)
          await rm(candidatePath, { force: true });
      }
      return cache;
    } catch (error) {
      signal?.throwIfAborted();
      // Storage failures during migration must not delete a valid AI result.
      if (!isMissingFileError(error)) throw error;
    }
  }
  return null;
}

export async function writeKnowledgeMarkdownRepairCache(
  paperDirectory: string,
  paperId: string,
  pdfPath: string,
  input: WriteKnowledgeMarkdownRepairCacheInput,
  signal?: AbortSignal,
): Promise<KnowledgeMarkdownRepairCache> {
  signal?.throwIfAborted();
  const sourceInfo = await stat(pdfPath);
  signal?.throwIfAborted();
  const cache: KnowledgeMarkdownRepairCache = {
    sourceMode: input.sourceMode,
    version: 2,
    paperId,
    source: {
      size: sourceInfo.size,
      mtimeMs: sourceInfo.mtimeMs,
    },
    markdown: normalizeMarkdown(
      input.sourceMode === "pdf-rebuild"
        ? filterPaperMarkdownContent(input.markdown)
        : input.markdown,
    ),
    pageCount: input.pageCount,
    model: input.model,
    protocol: input.protocol,
    repairedAt: input.repairedAt ?? new Date().toISOString(),
    warnings: [...input.warnings],
    repairReport: input.repairReport
      ? {
          ...input.repairReport,
          detectedIssues: [...input.repairReport.detectedIssues],
        }
      : undefined,
  };
  if (!cache.markdown) {
    throw new Error("无法缓存空的 AI Markdown。");
  }
  await mkdir(paperDirectory, { recursive: true });
  signal?.throwIfAborted();
  await writeCancellableUtf8(
    knowledgeMarkdownRepairCachePath(paperDirectory),
    `${JSON.stringify(cache, null, 2)}\n`,
    signal,
  );
  signal?.throwIfAborted();
  return cache;
}

export async function removeKnowledgeMarkdownRepairCache(
  paperDirectory: string,
  paperId?: string,
  legacyCacheRoot?: string,
): Promise<void> {
  await Promise.all([
    rm(knowledgeMarkdownRepairCachePath(paperDirectory), {
      force: true,
    }),
    paperId && legacyCacheRoot
      ? rm(legacyKnowledgeMarkdownRepairCachePath(legacyCacheRoot, paperId), {
          force: true,
        })
      : Promise.resolve(),
  ]);
}

function knowledgeMarkdownRepairCachePath(paperDirectory: string): string {
  return join(paperDirectory, "ai_repair.json");
}

function legacyKnowledgeMarkdownRepairCachePath(
  cacheRoot: string,
  paperId: string,
): string {
  const safePaperId =
    paperId.trim().replace(/[^A-Za-z0-9._-]+/g, "_") || "paper";
  return join(cacheRoot, `${safePaperId}.json`);
}

function parseKnowledgeMarkdownRepairCache(
  serialized: string,
): KnowledgeMarkdownRepairCache | null {
  try {
    const value = JSON.parse(serialized) as Record<string, unknown>;
    if (
      value.version !== 2 ||
      typeof value.paperId !== "string" ||
      typeof value.model !== "string" ||
      typeof value.repairedAt !== "string" ||
      typeof value.markdown !== "string" ||
      !value.markdown.trim() ||
      !Number.isInteger(value.pageCount) ||
      (value.pageCount as number) < 0 ||
      !Array.isArray(value.warnings) ||
      !value.warnings.every((warning) => typeof warning === "string") ||
      !value.source ||
      typeof value.source !== "object" ||
      Array.isArray(value.source)
    ) {
      return null;
    }
    const source = value.source as Record<string, unknown>;
    if (typeof source.size !== "number" || typeof source.mtimeMs !== "number") {
      return null;
    }
    const protocol =
      value.protocol === "responses" || value.protocol === "chat-completions"
        ? value.protocol
        : undefined;
    const repairReport = parseRepairReport(value.repairReport);
    return {
      sourceMode:
        value.sourceMode === "pdf-rebuild" ? "pdf-rebuild" : undefined,
      version: 2,
      paperId: value.paperId,
      source: { size: source.size, mtimeMs: source.mtimeMs },
      markdown: normalizeMarkdown(value.markdown),
      pageCount: value.pageCount as number,
      model: value.model,
      protocol,
      repairedAt: value.repairedAt,
      warnings: value.warnings as string[],
      repairReport,
    };
  } catch {
    return null;
  }
}

function parseRepairReport(
  value: unknown,
): KnowledgeMarkdownRepairCache["repairReport"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const report = value as Record<string, unknown>;
  if (
    !Number.isInteger(report.batchCount) ||
    !Number.isInteger(report.repairedBatchCount) ||
    !Number.isInteger(report.preservedBatchCount) ||
    !Array.isArray(report.detectedIssues) ||
    !report.detectedIssues.every((issue) => typeof issue === "string")
  ) {
    return undefined;
  }
  return {
    batchCount: report.batchCount as number,
    repairedBatchCount: report.repairedBatchCount as number,
    preservedBatchCount: report.preservedBatchCount as number,
    detectedIssues: report.detectedIssues as string[],
  };
}

function normalizeMarkdown(value: string): string {
  return `${value.replace(/\r\n?/g, "\n").trim()}\n`;
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
