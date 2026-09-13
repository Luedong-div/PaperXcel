import {
  normalizeCitationDoi,
  normalizeOpenAlexId,
  type CitationGraphCache,
  type CitationWorkRecord,
} from "../shared/citationGraph";
import { parseDiscoveryDoi } from "../shared/citationDiscovery";
import type {
  CitationGraphNode,
  CitationReferencesInput,
  CitationReferencesResult,
  Paper,
} from "../shared/contracts";
import type { OpenAlexClient } from "./openalex-client";
import type { CrossrefClient } from "./crossref-client";

interface ReferenceContext {
  papers: Paper[];
  cache: CitationGraphCache;
  client: OpenAlexClient;
  crossref: CrossrefClient;
}

interface ReferenceCatalog {
  keys: string[];
  works: Map<string, CitationWorkRecord>;
  expires: number;
}

// Bibliographies are independent of the visible graph and search filters.
// Keep fetched metadata in memory so inspecting a paper never adds graph nodes.
export class CitationReferenceService {
  private catalogs = new Map<string, ReferenceCatalog>();

  clear(): void {
    this.catalogs.clear();
  }

  async get(
    input: CitationReferencesInput,
    context: ReferenceContext,
  ): Promise<CitationReferencesResult> {
    const { papers, cache, client, crossref } = context;
    const doi = parseDiscoveryDoi(input.doi ?? "");
    const paper = papers.find(
      (candidate) =>
        candidate.id === input.paperId ||
        Boolean(doi && normalizeCitationDoi(candidate.doi) === doi),
    );
    const core = paper ? cache.cores[paper.id] : undefined;
    const openAlexId =
      normalizeOpenAlexId(input.openAlexId) ??
      normalizeOpenAlexId(core?.openAlexId);
    const recordId = input.nodeId?.startsWith("external:")
      ? input.nodeId.slice(9)
      : undefined;
    const root =
      cache.works[openAlexId ?? recordId ?? ""] ??
      Object.values(cache.works).find((work) =>
        Boolean(doi && normalizeCitationDoi(work.doi) === doi),
      );
    const lookupDoi = doi ?? parseDiscoveryDoi(paper?.doi ?? root?.doi ?? "");
    if (!root && !core && !openAlexId && !lookupDoi) {
      return {
        items: [],
        total: 0,
        warnings: ["这篇论文缺少 DOI 或 OpenAlex 标识，暂时无法查询参考文件。"],
      };
    }
    const key = JSON.stringify([
      paper?.id,
      openAlexId,
      recordId,
      lookupDoi,
      cache.updatedAt,
    ]);
    const now = Date.now();
    for (const [id, catalog] of this.catalogs) {
      if (catalog.expires <= now) this.catalogs.delete(id);
    }
    const warnings: string[] = [];
    let catalog = this.catalogs.get(key);
    if (!catalog) {
      let resolvedRoot: CitationWorkRecord | undefined = root;
      let keys = [
        ...new Set([
          ...(core?.referencedOpenAlexIds ?? []),
          ...(root?.referencedOpenAlexIds ?? []),
        ]),
      ];
      if (!keys.length && !normalizeOpenAlexId(root?.openAlexId)) {
        try {
          if (openAlexId)
            resolvedRoot = (
              await client.getWorksByOpenAlexIds([openAlexId])
            )[0];
          else if (lookupDoi)
            resolvedRoot = await client.getWorkByDoi(lookupDoi);
          keys = [...new Set(resolvedRoot?.referencedOpenAlexIds ?? [])];
        } catch (error) {
          warnings.push(errorMessage(error));
        }
      }
      if (!keys.length && lookupDoi) {
        try {
          keys = await crossref.getReferenceDois(lookupDoi, true);
          // A successful fallback provides a usable bibliography.
          if (keys.length) warnings.length = 0;
        } catch (error) {
          warnings.push(errorMessage(error));
        }
      }
      catalog = { keys, works: new Map(), expires: now + 20 * 60_000 };
      for (const ref of keys) {
        const cached = cache.works[ref];
        if (cached) catalog.works.set(ref, cached);
      }
      if (!warnings.length) {
        if (this.catalogs.size >= 50)
          this.catalogs.delete(this.catalogs.keys().next().value!);
        this.catalogs.set(key, catalog);
      }
    }
    const offset = boundedInteger(input.offset, 0, 0, catalog.keys.length);
    const limit = boundedInteger(input.limit, 50, 1, 100);
    const page = catalog.keys.slice(offset, offset + limit);
    const missing = page.filter((ref) => !catalog.works.has(ref));
    const ids = missing.filter((ref) => normalizeOpenAlexId(ref));
    const dois = missing.filter((ref) => parseDiscoveryDoi(ref));
    const fetched = await Promise.allSettled([
      ids.length ? client.getWorksByOpenAlexIds(ids) : Promise.resolve([]),
      dois.length ? client.getWorksByDois(dois) : Promise.resolve([]),
    ]);
    for (const result of fetched) {
      if (result.status === "rejected")
        warnings.push(errorMessage(result.reason));
      else
        for (const work of result.value) {
          catalog.works.set(work.openAlexId, work);
          if (work.doi)
            catalog.works.set(normalizeCitationDoi(work.doi)!, work);
        }
    }
    const unresolvedDois = dois.filter((ref) => !catalog.works.has(ref));
    // Limit Crossref concurrency when an OpenAlex batch has missing records.
    for (let index = 0; index < unresolvedDois.length; index += 6) {
      const batch = unresolvedDois.slice(index, index + 6);
      const results = await Promise.allSettled(
        batch.map((ref) => crossref.getWorkByDoi(ref, undefined, true)),
      );
      results.forEach((result, position) => {
        if (result.status === "rejected")
          warnings.push(errorMessage(result.reason));
        else if (result.value?.title) {
          const ref = batch[position];
          catalog.works.set(ref, {
            ...result.value,
            title: result.value.title,
            doi: ref,
            openAlexId: `doi:${ref}`,
            referencedOpenAlexIds: [],
            metadataSources: ["crossref"],
          });
        }
      });
    }
    const unresolvedCount = page.filter(
      (ref) => !catalog.works.has(ref),
    ).length;
    if (unresolvedCount)
      warnings.push(
        `${unresolvedCount} 篇参考文件暂未取得详细信息，已保留原始标识，可重试加载。`,
      );
    return {
      items: page.map((ref) =>
        referenceNode(ref, catalog!.works.get(ref), context),
      ),
      total: catalog.keys.length,
      nextOffset:
        offset + limit < catalog.keys.length ? offset + limit : undefined,
      warnings: [...new Set(warnings)],
    };
  }
}

function referenceNode(
  key: string,
  work: CitationWorkRecord | undefined,
  { papers, cache }: ReferenceContext,
): CitationGraphNode {
  const openAlexId = normalizeOpenAlexId(work?.openAlexId ?? key);
  const doi = parseDiscoveryDoi(work?.doi ?? key);
  const paper = papers.find((candidate) =>
    Boolean(
      (doi && normalizeCitationDoi(candidate.doi) === doi) ||
      (openAlexId && cache.cores[candidate.id]?.openAlexId === openAlexId),
    ),
  );
  return {
    ...work,
    id: paper ? `paper:${paper.id}` : `external:${work?.openAlexId ?? key}`,
    kind: paper ? "library" : "external",
    paperId: paper?.id,
    openAlexId,
    doi,
    title: paper?.title ?? work?.title ?? `文献信息暂不可用（${key}）`,
    authors: paper?.authors ?? work?.authors ?? [],
    year: paper?.year ?? work?.year,
    abstract: paper?.abstract ?? work?.abstract,
    sourceUrl:
      paper?.sourceUrl ??
      work?.sourceUrl ??
      (doi
        ? `https://doi.org/${doi}`
        : openAlexId
          ? `https://openalex.org/${openAlexId}`
          : undefined),
    referencedByLibrary: false,
    citesLibrary: false,
    matchStatus: work ? (work.matchStatus ?? "verified") : "unresolved",
  };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  return Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value!)))
    : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
