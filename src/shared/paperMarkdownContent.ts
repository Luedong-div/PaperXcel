export interface PaperMarkdownFilterState {
  reportingSummaryActive?: boolean;
  reportingSummaryLevel?: number;
}

export interface PaperMarkdownContentScan extends PaperMarkdownFilterState {
  content: string;
  /** Pages made empty by excluding reporting forms; original page markers remain. */
  skippedPages: number[];
}

/** Remove publisher reporting forms, while retaining the article and PDF boundaries. */
export function filterPaperMarkdownContent(markdown: string): string {
  return scanPaperMarkdownContent(markdown).content;
}

/** State is the accepted batch boundary, never the unfinished streaming tail. */
export function scanPaperMarkdownContent(
  markdown: string,
  options: PaperMarkdownFilterState & { streaming?: boolean } = {},
): PaperMarkdownContentScan {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  const skippedPages: number[] = [];
  let active = options.reportingSummaryActive ?? false;
  let level = active ? options.reportingSummaryLevel : undefined;
  let linkSection = false;
  let fence: { character: string; length: number } | undefined;
  let htmlCode = false;
  let math = false;
  let changed = false;
  let page: number | undefined;
  let pageHasContent = false;
  let pageHasRemovedContent = false;
  const finishPage = () => {
    if (page !== undefined && pageHasRemovedContent && !pageHasContent)
      skippedPages.push(page);
  };
  const keep = (line: string) => {
    kept.push(line);
    if (line.trim()) pageHasContent = true;
  };
  const remove = (line: string) => {
    changed = true;
    if (line.trim()) pageHasRemovedContent = true;
  };
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceMatch && !htmlCode && !math) {
      if (!fence) {
        fence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
      } else if (
        fence.character === fenceMatch[1][0] &&
        fenceMatch[1].length >= fence.length &&
        !fenceMatch[2].trim()
      ) {
        fence = undefined;
      }
      (active ? remove : keep)(line);
      continue;
    }
    if (fence) {
      (active ? remove : keep)(line);
      continue;
    }
    if (/^\s*<(?:pre|code)(?:\s|>)/i.test(line)) htmlCode = true;
    if (htmlCode) {
      (active ? remove : keep)(line);
      if (/<\/(?:pre|code)\s*>/i.test(line)) htmlCode = false;
      continue;
    }
    if (/^(?:\$\$|\\\[|\\\])\s*$/.test(trimmed)) {
      math = !math;
      (active ? remove : keep)(line);
      continue;
    }
    if (math || /^(?: {4}|\t)/.test(line)) {
      (active ? remove : keep)(line);
      continue;
    }
    const marker = trimmed.match(/^<!--\s*page\s*:\s*(\d+)\s*-->$/i);
    if (marker) {
      finishPage();
      page = Number(marker[1]);
      pageHasContent = false;
      pageHasRemovedContent = false;
      kept.push(line);
      continue;
    }
    const heading = readHeading(line, lines[index + 1]);
    if (isReportingHeading(heading.text)) {
      active = true;
      level = heading.level;
      linkSection = isArticleReportingLink(lines, index);
    } else if (active && isArticleReportingLinkParagraph(trimmed)) {
      // The title can end the previous PDF batch. Its standard link sentence
      // still identifies the short article subsection when the next batch opens.
      linkSection = true;
    } else if (
      active &&
      (isArticleHeading(heading.text) ||
        (linkSection && heading.level !== undefined)) &&
      (level === undefined ||
        (heading.level !== undefined && heading.level <= level))
    ) {
      active = false;
      level = undefined;
      linkSection = false;
    }
    if (active) remove(line);
    else if (
      options.streaming &&
      index === lines.length - 1 &&
      trimmed &&
      isPossibleReportingHeading(heading.text)
    ) {
      // A heading can arrive as several SSE tokens; do not briefly display it.
      remove(line);
    } else keep(line);
  }
  finishPage();
  return {
    content: changed ? kept.join("\n") : markdown,
    // A short link subsection is fully represented by its known link sentence.
    // It must not carry the full form's exclusion into the next PDF batch.
    reportingSummaryActive: active && !linkSection,
    reportingSummaryLevel: active && !linkSection ? level : undefined,
    skippedPages,
  };
}

function readHeading(
  line: string,
  next?: string,
): { text: string; level?: number } {
  let text = line.trim();
  let level: number | undefined;
  const atx = text.match(/^(#{1,6})\s+(.*?)\s*#*$/);
  const html = text.match(/^<h([1-6])(?:\s[^>]*)?>(.*?)<\/h\1>$/i);
  if (atx) {
    level = atx[1].length;
    text = atx[2];
  } else if (html) {
    level = Number(html[1]);
    text = html[2];
  } else if (next && /^\s{0,3}(?:={3,}|-{3,})\s*$/.test(next)) {
    level = next.trim()[0] === "=" ? 1 : 2;
  }
  text = text
    .replace(/^(?:\*\*|__)(.*)(?:\*\*|__)$/, "$1")
    .replace(/^(?:(?:\d+(?:\.\d+)*|[IVXLCDM]+)[.)]?\s+)/i, "")
    .replace(/\s*[:：]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return { text, level };
}

function isReportingHeading(text: string): boolean {
  return /^(?:(?:nature(?:\s+(?:research|portfolio))?)[\s:—–-]+)?reporting\s+summary(?:\s*\((?:continued|cont\.?)\))?$/i.test(
    text,
  );
}

function isPossibleReportingHeading(text: string): boolean {
  const value = text
    .replace(/^(?:\*\*|__)/, "")
    .replace(/(?:\*\*|__)$/, "")
    .toLowerCase();
  return [
    "reporting summary",
    "nature reporting summary",
    "nature research reporting summary",
    "nature portfolio reporting summary",
  ].some((heading) => heading.startsWith(value));
}

function isArticleReportingLink(lines: string[], index: number): boolean {
  // Nature articles also contain a short section linking to the separate form.
  // Exclude that small subsection too, ending at its next peer article heading.
  const paragraph = lines.slice(index + 1).find((line) => line.trim());
  return Boolean(
    paragraph && isArticleReportingLinkParagraph(paragraph.trim()),
  );
}

function isArticleReportingLinkParagraph(paragraph: string): boolean {
  return /^further\s+information\s+on\s+research\s+design\b.*reporting\s+summary\b.*linked\s+to\s+this\s+article\.?$/i.test(
    paragraph,
  );
}

function isArticleHeading(text: string): boolean {
  // Reporting forms have their own Statistics, Software and code, Data collection,
  // Life sciences and Data availability fields. None are article boundaries.
  return /^(?:abstract|introduction|background|(?:online\s+)?methods|materials\s+and\s+methods|experimental\s+(?:methods|section|details|procedures)|results(?:\s+and\s+discussion)?|discussion|conclusions?|supplementary\s+(?:methods|notes?)|supporting\s+information|extended\s+data(?:\s+(?:figures|tables))?|appendix(?:\s+[A-Z\d]+)?|摘要|引言|研究方法|材料与方法|实验方法|实验部分|结果(?:与讨论)?|讨论|结论|附录(?:[A-Z\d一二三四五六七八九十]+)?)$/i.test(
    text,
  );
}
