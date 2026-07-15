import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderProtocol } from "../shared/contracts";

export interface KnowledgeMarkdownRepairCache {
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
}

interface WriteKnowledgeMarkdownRepairCacheInput {
  markdown: string;
  pageCount: number;
  model: string;
  protocol?: Exclude<ProviderProtocol, "auto">;
  repairedAt?: string;
  warnings: string[];
}

export async function readKnowledgeMarkdownRepairCache(
  paperDirectory: string,
  paperId: string,
  pdfPath: string,
  legacyCacheRoot?: string,
): Promise<KnowledgeMarkdownRepairCache | null> {
  const cachePath = knowledgeMarkdownRepairCachePath(paperDirectory);
  const legacyCachePath = legacyCacheRoot
    ? legacyKnowledgeMarkdownRepairCachePath(legacyCacheRoot, paperId)
    : undefined;
  const sourceInfo = await stat(pdfPath);
  for (const candidatePath of [cachePath, legacyCachePath]) {
    if (!candidatePath) continue;
    try {
      const serialized = await readFile(candidatePath, "utf8");
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
      if (candidatePath !== cachePath) {
        await mkdir(paperDirectory, { recursive: true });
        await writeFile(
          cachePath,
          `${JSON.stringify(cache, null, 2)}\n`,
          "utf8",
        );
        await rm(candidatePath, { force: true });
      }
      return cache;
    } catch (error) {
      if (!isMissingFileError(error)) {
        await rm(candidatePath, { force: true });
      }
    }
  }
  return null;
}

export async function writeKnowledgeMarkdownRepairCache(
  paperDirectory: string,
  paperId: string,
  pdfPath: string,
  input: WriteKnowledgeMarkdownRepairCacheInput,
): Promise<KnowledgeMarkdownRepairCache> {
  const sourceInfo = await stat(pdfPath);
  const cache: KnowledgeMarkdownRepairCache = {
    version: 2,
    paperId,
    source: {
      size: sourceInfo.size,
      mtimeMs: sourceInfo.mtimeMs,
    },
    markdown: normalizeMarkdown(input.markdown),
    pageCount: input.pageCount,
    model: input.model,
    protocol: input.protocol,
    repairedAt: input.repairedAt ?? new Date().toISOString(),
    warnings: [...input.warnings],
  };
  if (!cache.markdown) {
    throw new Error("无法缓存空的 AI Markdown。");
  }
  await mkdir(paperDirectory, { recursive: true });
  await writeFile(
    knowledgeMarkdownRepairCachePath(paperDirectory),
    `${JSON.stringify(cache, null, 2)}\n`,
    "utf8",
  );
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
    return {
      version: 2,
      paperId: value.paperId,
      source: { size: source.size, mtimeMs: source.mtimeMs },
      markdown: normalizeMarkdown(value.markdown),
      pageCount: value.pageCount as number,
      model: value.model,
      protocol,
      repairedAt: value.repairedAt,
      warnings: value.warnings as string[],
    };
  } catch {
    return null;
  }
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
