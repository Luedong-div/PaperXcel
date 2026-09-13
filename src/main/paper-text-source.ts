import type { DocumentPageText } from "../shared/contracts";
import { filterPaperMarkdownContent } from "../shared/paperMarkdownContent";

export interface PaperTextSegment {
  /** Stable for the same page order and segmentation settings. */
  id: string;
  page: number;
  source: string;
}

export interface PreparedPaperText {
  segments: PaperTextSegment[];
  /** Includes pages whose content was entirely excluded. */
  pageNumbers: number[];
  /** Filtered source with the same page markers as repaired paper artifacts. */
  content: string;
  skipped: {
    /** Removed Markdown/HTML image nodes and standalone image placeholders. */
    images: number;
    /** Nonempty lines removed from reference sections, including headings. */
    references: number;
    /** Nonempty lines of standalone publication and copyright information. */
    publisher: number;
  };
}

/** Prepare text only; never changes an artifact or asks a model to reproduce images. */
export function preparePaperText(
  pages: DocumentPageText[],
  options: { maxSegmentCharacters?: number } = {},
): PreparedPaperText {
  const limit = options.maxSegmentCharacters ?? 6000;
  if (!Number.isSafeInteger(limit) || limit < 2) {
    throw new Error("maxSegmentCharacters must be an integer of at least 2.");
  }
  const result: PreparedPaperText = {
    segments: [],
    pageNumbers: [...new Set(pages.map((page) => page.page))].sort(
      (a, b) => a - b,
    ),
    content: "",
    skipped: { images: 0, references: 0, publisher: 0 },
  };
  let references = false;
  for (const page of pages) {
    if (!Number.isSafeInteger(page.page) || page.page < 1) {
      throw new Error("Paper pages must have positive integer page numbers.");
    }
  }
  const filteredPages = markdownToDocumentPages(
    filterPaperMarkdownContent(
      [...pages]
        .sort((a, b) => a.page - b.page)
        .map((page) => `<!-- page: ${page.page} -->\n\n${page.text}`)
        .join("\n\n"),
    ),
  );
  for (const page of filteredPages) {
    const withoutImages = removeImageNodes(page.text.replace(/\r\n?/g, "\n"));
    result.skipped.images += withoutImages.count;
    const lines = withoutImages.text.split("\n");
    const nonempty = lines.flatMap((line, index) =>
      line.trim() ? [index] : [],
    );
    const boundary = new Set([...nonempty.slice(0, 4), ...nonempty.slice(-4)]);
    const kept: string[] = [];
    let fence: string | undefined;
    let math = false;
    let publisherParagraph = false;
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim();
      const heading = normalizedHeading(line);
      if (references && isBodyHeading(heading)) references = false;
      if (!fence && !math && isReferencesHeading(heading)) references = true;
      if (references) {
        if (trimmed) result.skipped.references++;
        continue;
      }
      const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
      if (fenceMatch && (!fence || fenceMatch[1][0] === fence[0])) {
        fence = fence ? undefined : fenceMatch[1];
        kept.push(line);
        continue;
      }
      if (!fence && /^(?:\$\$|\\\[|\\\])\s*$/.test(trimmed)) {
        math = !math;
        kept.push(line);
        continue;
      }
      if (fence || math) {
        kept.push(line);
        continue;
      }
      if (!trimmed || isBodyHeading(heading)) publisherParagraph = false;
      if (isPublisherParagraphStart(trimmed)) publisherParagraph = true;
      if (publisherParagraph || isPublisherLine(trimmed, boundary.has(index))) {
        if (trimmed) result.skipped.publisher++;
        continue;
      }
      kept.push(line);
    }
    const text = kept
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!text) continue;
    const chunks = segmentPage(text, limit);
    const pageOffset = result.segments.filter(
      (segment) => segment.page === page.page,
    ).length;
    result.segments.push(
      ...chunks.map((source, index) => ({
        id: `p${page.page}-s${pageOffset + index + 1}`,
        page: page.page,
        source,
      })),
    );
  }
  result.content = renderPaperText(
    result.segments,
    undefined,
    result.pageNumbers,
  );
  return result;
}

/** Render replacements in source order while retaining empty PDF pages. */
export function renderPaperText(
  segments: readonly PaperTextSegment[],
  replacements?: ReadonlyMap<string, string>,
  pageNumbers?: readonly number[],
): string {
  const pages = new Map<number, string[]>();
  for (const page of pageNumbers ?? []) pages.set(page, []);
  for (const segment of segments) {
    if (!pages.has(segment.page)) pages.set(segment.page, []);
    const text = replacements?.get(segment.id) ?? segment.source;
    if (text.trim()) pages.get(segment.page)!.push(text.trim());
  }
  return [...pages]
    .sort(([a], [b]) => a - b)
    .map(([page, paragraphs]) =>
      [`<!-- page: ${page} -->`, ...paragraphs].join("\n\n"),
    )
    .join("\n\n");
}

/** Match artifacts without importing the document engine and its SQLite runtime. */
export function markdownToDocumentPages(markdown: string): DocumentPageText[] {
  const normalized = markdown.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const preamble: string[] = [];
  const pages = new Map<number, string[]>();
  let currentPage: number | undefined;
  let fence: string | undefined;
  for (const line of normalized.split("\n")) {
    const fenceMatch = line.trim().match(/^(`{3,}|~{3,})/);
    if (fenceMatch && (!fence || fenceMatch[1][0] === fence[0]))
      fence = fence ? undefined : fenceMatch[1];
    const match =
      !fence &&
      (line.match(/^\s*<!--\s*page\s*:\s*(\d+)\s*-->\s*$/i) ??
        line.match(/^\s{0,3}#{1,6}\s*第\s*(\d+)\s*页\s*$/u) ??
        line.match(/^\s{0,3}#{1,6}\s*page\s*(\d+)\s*$/i));
    const page = match ? Number(match[1]) : undefined;
    if (page !== undefined && Number.isSafeInteger(page) && page > 0) {
      currentPage = page;
      if (!pages.has(page)) pages.set(page, []);
    } else if (currentPage === undefined) preamble.push(line);
    else pages.get(currentPage)!.push(line);
  }
  if (!pages.size) return [{ page: 1, text: normalized }];
  const ordered = [...pages.keys()].sort((a, b) => a - b);
  if (preamble.some((line) => line.trim()))
    pages.get(ordered[0])!.unshift(...preamble, "");
  return ordered.map((page) => ({
    page,
    text: pages.get(page)!.join("\n").trim(),
  }));
}

function normalizedHeading(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+#+$/, "")
    .replace(/^(?:\*\*|__)([\s\S]*)(?:\*\*|__)$/, "$1")
    .replace(/^(?:(?:\d+(?:\.\d+)*|[IVXLCDM]+)[.)]?\s+)/i, "")
    .replace(/[：:]\s*$/, "")
    .trim();
}

function isReferencesHeading(value: string): boolean {
  return /^(?:references(?:\s+and\s+notes)?|bibliography|literature\s+cited|参考文献|參考文獻)(?:\s*[（(]?(?:continued|cont\.?|续|續)[）)]?)?$/i.test(
    value,
  );
}

function isBodyHeading(value: string): boolean {
  return /^(?:abstract|introduction|background|(?:online\s+)?methods|materials(?:\s+and\s+methods)?|experimental(?:\s+(?:methods|section|details|procedures))?|results(?:\s+and\s+discussion)?|discussion|conclusions?|acknowledg(?:e)?ments?|author\s+contributions?|competing\s+interests?|(?:data|code)\s+availability(?:\s+statement)?|additional\s+information|supplementary\s+(?:information|material|materials|methods|notes?)|supporting\s+information|extended\s+data(?:\s+(?:figures|tables))?|appendix(?:\s+[A-Z\d]+)?|appendices|摘要|引言|研究方法|材料与方法|实验方法|实验部分|结果(?:与讨论)?|讨论|结论|致谢|附录(?:[A-Z\d一二三四五六七八九十]+)?|补充材料|数据可用性)$/i.test(
    value,
  );
}

function isPublisherParagraphStart(value: string): boolean {
  const heading = normalizedHeading(value);
  return (
    /^(?:publisher[’']?s\s+note|出版者说明)[.:：]?$/i.test(heading) ||
    /^(?:publisher[’']?s\s+note\s*[:.：]?\s*)?springer\s+nature\s+remains\s+neutral\b/i.test(
      heading,
    ) ||
    /^open\s+access\s*[:.]?\s+this\s+(?:article|work)\s+is\s+licensed\b/i.test(
      heading,
    ) ||
    /^this\s+(?:article|work)\s+is\s+licensed\s+under\s+a\s+creative\s+commons\b/i.test(
      heading,
    )
  );
}

function isPublisherLine(value: string, boundary: boolean): boolean {
  const text = normalizedHeading(value);
  if (
    /^(?:nature\s+(?:portfolio|research)|springer\s+nature|springer(?:open)?|elsevier|wiley(?:[- ]blackwell)?|taylor\s*&\s*francis)(?:\s*[|·—–-]\s*\d+)?$/i.test(
      text,
    )
  )
    return true;
  if (
    text.length < 700 &&
    /^(?:©|\(c\)|copyright\s+(?:©|\(c\)|\d{4})|all\s+rights\s+reserved\b)/i.test(
      text,
    )
  )
    return true;
  if (!boundary) return false;
  if (/^portfolio$/i.test(text)) return true;
  return (
    /^(?:https?:\/\/)?(?:www\.)?nature\.com(?:\/\S*)?$/i.test(text) ||
    /^(?:article\s+)?https?:\/\/(?:dx\.)?doi\.org\/\S+$/i.test(text) ||
    /^(?:received|accepted|published(?:\s+online)?):\s*(?:\d{1,2}\s+[A-Z][a-z]+\s+\d{4}|[A-Z][a-z]+\s+\d{1,2},?\s+\d{4}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\.?$/i.test(
      text,
    ) ||
    /^(?:nature\s+(?:communications|materials|physics|chemistry|nanotechnology)|scientific\s+reports)\s*[|·]\s*(?:\(\d{4}\)|\d{4})[\s\d:.,|–—-]*$/i.test(
      text,
    )
  );
}

function removeImageNodes(source: string): { text: string; count: number } {
  let count = 0;
  let fence: string | undefined;
  let math = false;
  let pending: string[] = [];
  const parts: string[] = [];
  const referenceIds = new Set(
    [...source.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*\S/gm)].map((match) =>
      match[1].toLowerCase(),
    ),
  );
  const flush = () => {
    if (!pending.length) return;
    const value = pending.join("\n");
    const filtered = stripImageMarkup(value, referenceIds);
    count += filtered.count;
    parts.push(filtered.text);
    pending = [];
  };
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    const marker = trimmed.match(/^(`{3,}|~{3,})/);
    if (marker && (!fence || marker[1][0] === fence[0])) {
      flush();
      fence = fence ? undefined : marker[1];
      parts.push(line);
      continue;
    }
    if (!fence && /^(?:\$\$|\\\[|\\\])\s*$/.test(trimmed)) {
      flush();
      math = !math;
      parts.push(line);
      continue;
    }
    if (fence || math) {
      flush();
      parts.push(line);
      continue;
    }
    if (
      /^(?:[_*]*[（([]\s*(?:(?:image|figure|图像|图片|插图)(?:\s+(?:omitted|placeholder|removed|not\s+(?:shown|available)))?|(?:图片|图像)(?:已省略|占位|省略))\s*[）)\]][_*]*|<!--\s*(?:image|figure|图片|图像)(?:\s+(?:omitted|placeholder))?\s*-->)$/i.test(
        trimmed,
      )
    ) {
      count++;
      pending.push("");
    } else pending.push(line);
  }
  flush();
  return { text: parts.join("\n"), count };
}

function stripImageMarkup(
  value: string,
  referenceIds: Set<string>,
): { text: string; count: number } {
  let count = 0;
  let output = "";
  // Balanced Markdown and quoted HTML attributes can span multiple source lines.
  for (let index = 0; index < value.length; ) {
    if (value[index] === "`") {
      const ticks = value.slice(index).match(/^`+/)![0];
      const codeEnd = value.indexOf(ticks, index + ticks.length);
      if (codeEnd >= 0) {
        output += value.slice(index, codeEnd + ticks.length);
        index = codeEnd + ticks.length;
        continue;
      }
    }
    if (value[index] === "<") {
      const tag =
        value
          .slice(index)
          .match(/^<img\b(?:[^>"']|"[^"]*"|'[^']*')*\/?\s*>/i) ??
        value.slice(index).match(/^<svg\b[^>]*>[\s\S]*?<\/svg\s*>/i);
      if (tag) {
        count++;
        index += tag[0].length;
        continue;
      }
      const wrapper =
        value
          .slice(index)
          .match(/^<\/?(?:figure|figcaption|picture)\b[^>]*>/i) ??
        value
          .slice(index)
          .match(/^<source\b(?:[^>"']|"[^"]*"|'[^']*')*\/?\s*>/i);
      if (wrapper) {
        index += wrapper[0].length;
        continue;
      }
    }
    if (
      value[index] !== "!" ||
      value[index + 1] !== "[" ||
      value[index - 1] === "\\"
    ) {
      output += value[index++];
      continue;
    }
    const altEnd = balancedEnd(value, index + 1, "[", "]");
    if (altEnd < 0) {
      output += value[index++];
      continue;
    }
    const next = value[altEnd + 1];
    const end =
      next === "("
        ? balancedEnd(value, altEnd + 1, "(", ")")
        : next === "["
          ? balancedEnd(value, altEnd + 1, "[", "]")
          : referenceIds.has(value.slice(index + 2, altEnd).toLowerCase())
            ? altEnd
            : -1;
    if (end < 0) {
      output += value[index++];
      continue;
    }
    count++;
    index = end + 1;
  }
  return { text: output, count };
}

function balancedEnd(
  value: string,
  start: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let index = start; index < value.length; index++) {
    if (value[index] === "\\") {
      index++;
      continue;
    }
    if (value[index] === open) depth++;
    if (value[index] === close && --depth === 0) return index;
  }
  return -1;
}

function segmentPage(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let buffer = "";
  for (const paragraph of text.split(/\n[ \t]*\n/).filter(Boolean)) {
    if (buffer && buffer.length + 2 + paragraph.length <= limit) {
      buffer += `\n\n${paragraph}`;
      continue;
    }
    if (buffer) {
      chunks.push(buffer);
    }
    let remaining = paragraph;
    while (remaining.length > limit) {
      let end = Math.max(
        remaining.lastIndexOf("\n", limit),
        remaining.lastIndexOf(" ", limit),
      );
      if (end < Math.floor(limit / 2)) end = limit;
      if (end === limit && /[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
      chunks.push(remaining.slice(0, end).trimEnd());
      remaining = remaining.slice(end).trimStart();
    }
    buffer = remaining;
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}
