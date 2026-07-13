export interface ZoteroCreator {
  firstName?: string;
  lastName?: string;
  name?: string;
  creatorType?: string;
}

export interface ZoteroItemData {
  key?: string;
  itemType?: string;
  title?: string;
  creators?: ZoteroCreator[];
  publicationTitle?: string;
  proceedingsTitle?: string;
  publisher?: string;
  date?: string;
  DOI?: string;
  abstractNote?: string;
  url?: string;
  tags?: Array<{ tag?: string }>;
  contentType?: string;
  filename?: string;
  path?: string;
  linkMode?: string;
}

export interface ZoteroItem {
  key: string;
  data: ZoteroItemData;
  links?: {
    alternate?: {
      href?: string;
    };
  };
}

export interface ZoteroPaperMetadata {
  title: string;
  authors: string[];
  journal?: string;
  year?: number;
  doi?: string;
  abstract?: string;
  sourceUrl?: string;
  tags: string[];
  zoteroItemKey: string;
}

const IMPORTABLE_ITEM_TYPES = new Set([
  "journalArticle",
  "conferencePaper",
  "book",
  "bookSection",
  "thesis",
  "report",
  "preprint",
  "manuscript",
]);

export function isImportableZoteroItem(item: ZoteroItem): boolean {
  return IMPORTABLE_ITEM_TYPES.has(item.data.itemType ?? "");
}

export function normalizeZoteroUserLibraryId(value: string): string {
  return value
    .replace(/\s+/g, "")
    .replace(/^(?:https?:\/\/)?(?:www\.)?zotero\.org\/users\//i, "")
    .replace(/^users\//i, "")
    .replace(/[?#].*$/, "")
    .replace(/^\/+|\/+$/g, "");
}

export function buildZoteroUserItemUrl(
  userLibraryId: string,
  itemKey: string,
): string | undefined {
  const libraryId = normalizeZoteroUserLibraryId(userLibraryId);
  const normalizedItemKey = itemKey.trim();
  if (!libraryId || !normalizedItemKey) return undefined;
  return `https://www.zotero.org/users/${encodeURIComponent(libraryId)}/items/${encodeURIComponent(normalizedItemKey)}`;
}

export function mapZoteroItem(
  item: ZoteroItem,
  userLibraryId?: string,
): ZoteroPaperMetadata {
  const data = item.data;
  return {
    title: data.title?.trim() || `Zotero ${item.key}`,
    authors:
      data.creators
        ?.filter((creator) =>
          ["author", "editor", "contributor"].includes(
            creator.creatorType ?? "author",
          ),
        )
        .map(formatCreator)
        .filter(Boolean) ?? [],
    journal:
      data.publicationTitle?.trim() ||
      data.proceedingsTitle?.trim() ||
      data.publisher?.trim() ||
      undefined,
    year: parseZoteroYear(data.date),
    doi: normalizeOptionalDoi(data.DOI),
    abstract: data.abstractNote?.trim() || undefined,
    sourceUrl:
      data.url?.trim() ||
      item.links?.alternate?.href?.trim() ||
      (userLibraryId
        ? buildZoteroUserItemUrl(userLibraryId, item.key)
        : undefined),
    tags: [
      ...new Set(
        (data.tags ?? [])
          .map((tag) => tag.tag?.trim())
          .filter((tag): tag is string => Boolean(tag)),
      ),
    ],
    zoteroItemKey: item.key,
  };
}

export function selectZoteroPdfAttachment(
  items: ZoteroItem[],
): ZoteroItem | undefined {
  return items.find((item) => {
    if (item.data.itemType !== "attachment") return false;
    const contentType = item.data.contentType?.toLowerCase() ?? "";
    const filename = item.data.filename?.toLowerCase() ?? "";
    return contentType === "application/pdf" || filename.endsWith(".pdf");
  });
}

export function parseZoteroYear(value?: string): number | undefined {
  const match = value?.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return match ? Number(match[1]) : undefined;
}

export function safeZoteroPdfFileName(value?: string): string {
  const leaf = value?.trim().split(/[\\/]/).pop()?.trim() || "source.pdf";
  let sanitized = leaf
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!sanitized) sanitized = "source";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }
  if (!/\.pdf$/i.test(sanitized)) sanitized += ".pdf";
  if (sanitized.length > 180) {
    sanitized = `${sanitized.slice(0, 176).replace(/[. ]+$/g, "")}.pdf`;
  }
  return sanitized;
}

function formatCreator(creator: ZoteroCreator): string {
  if (creator.name?.trim()) return creator.name.trim();
  return [creator.firstName?.trim(), creator.lastName?.trim()]
    .filter(Boolean)
    .join(" ");
}

function normalizeOptionalDoi(value?: string): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
  return normalized || undefined;
}
