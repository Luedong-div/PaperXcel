import type {
  CitationContentMatchPriority,
  CitationDiscoveryResult,
  CitationDiscoveryReason,
  Paper,
} from "../shared/contracts";
import type {
  CitationGraphCache,
  CitationWorkRecord,
} from "../shared/citationGraph";
import {
  buildCitationDiscoveryQueries,
  buildCitationDiscoveryTerms,
  rankCitationDiscoveryCandidates,
  type CitationDiscoveryWorkInput,
} from "../shared/citationDiscovery";
import type { OpenAlexClient } from "./openalex-client";

export interface DiscoverCitationWorksOptions {
  papers: Paper[];
  cache: CitationGraphCache;
  client: OpenAlexClient;
  query?: string;
  limit?: number;
  contentMatchPriority?: CitationContentMatchPriority;
  now?: Date;
}

export async function discoverCitationWorks({
  papers,
  cache,
  client,
  query = "",
  limit = 80,
  contentMatchPriority = "standard",
  now = new Date(),
}: DiscoverCitationWorksOptions): Promise<{
  result: CitationDiscoveryResult;
  works: CitationWorkRecord[];
}> {
  if (papers.length === 0) {
    throw new Error("请先选择至少一篇本地论文作为推荐起点。");
  }

  const warnings: string[] = [];
  const candidates: CitationDiscoveryWorkInput[] = Object.values(
    cache.works,
  ).map((work) => ({ work }));
  const queries = buildCitationDiscoveryQueries(papers, query);
  const searchLimit = Math.max(20, Math.min(60, Math.ceil(limit * 0.9)));

  await mapWithConcurrency(queries, 3, async (searchQuery) => {
    try {
      const works = await client.findWorksBySearch(searchQuery, searchLimit);
      candidates.push(
        ...works.map((work) => ({
          work,
          reasons: ["topic-match" as CitationDiscoveryReason],
        })),
      );
    } catch (error) {
      warnings.push(
        `内容关键词检索“${searchQuery.slice(0, 42)}”失败：${errorMessage(error)}`,
      );
    }
  });

  const seedCores = papers
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

  if (papers.length > seedCores.length && seedCores.length === 12) {
    warnings.push("引用检索已优先处理前 12 篇种子论文。");
  }

  const seedOpenAlexIds = Object.fromEntries(
    papers.map((paper) => [paper.id, cache.cores[paper.id]?.openAlexId]),
  );
  const seedReferences = Object.fromEntries(
    papers.map((paper) => [
      paper.id,
      cache.cores[paper.id]?.referencedOpenAlexIds ?? [],
    ]),
  );
  const ranked = rankCitationDiscoveryCandidates({
    papers,
    candidates,
    query,
    seedOpenAlexIds,
    seedReferences,
    limit,
    contentMatchPriority,
    now,
  });
  const works = uniqueWorks(candidates.map((candidate) => candidate.work));

  return {
    result: {
      candidates: ranked,
      query: query.trim(),
      terms: buildCitationDiscoveryTerms(papers, query),
      searchedAt: now.toISOString(),
      warnings,
    },
    works,
  };
}

function uniqueWorks(works: CitationWorkRecord[]): CitationWorkRecord[] {
  const byId = new Map<string, CitationWorkRecord>();
  for (const work of works) byId.set(work.openAlexId, work);
  return [...byId.values()];
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
