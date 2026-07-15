export interface PdfLayoutTextItem {
  str: string;
  transform: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
}

interface PositionedItem {
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  hasEOL: boolean;
}

interface LayoutLine {
  text: string;
  x: number;
  right: number;
  y: number;
  fontSize: number;
}

interface ColumnModel {
  split: number;
  pageWidth: number;
}

export function reconstructPdfPageText(
  sourceItems: PdfLayoutTextItem[],
  pageWidth: number,
): string {
  const items = sourceItems
    .map(positionItem)
    .filter((item): item is PositionedItem => Boolean(item));
  if (!items.length) return "";

  const lines = groupItemsIntoLines(items);
  if (!lines.length) return "";
  const columnModel = detectColumnModel(lines, pageWidth);
  const ordered = columnModel
    ? orderTwoColumnLines(lines, columnModel)
    : [...lines].sort(compareVisualLines);
  return renderReadableParagraphs(ordered);
}

export function normalizePdfPageText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u00ad/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/(\p{L})-\n(?=\p{Ll})/gu, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function positionItem(item: PdfLayoutTextItem): PositionedItem | undefined {
  const text = item.str.replace(/\u00ad/g, "").trim();
  if (!text) return undefined;
  const x = Number(item.transform[4]);
  const y = Number(item.transform[5]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const fontSize = Math.max(
    Math.abs(Number(item.transform[3])) || 0,
    Math.abs(Number(item.height)) || 0,
    1,
  );
  const estimatedWidth = Math.max(
    text.length * fontSize * 0.44,
    fontSize * 0.5,
  );
  const width = Math.max(Number(item.width) || 0, estimatedWidth);
  return {
    text,
    x,
    y,
    width,
    fontSize,
    hasEOL: Boolean(item.hasEOL),
  };
}

function groupItemsIntoLines(items: PositionedItem[]): LayoutLine[] {
  const groups: Array<{
    y: number;
    fontSize: number;
    items: PositionedItem[];
  }> = [];
  for (const item of [...items].sort(
    (left, right) => right.y - left.y || left.x - right.x,
  )) {
    let closest:
      | {
          y: number;
          fontSize: number;
          items: PositionedItem[];
        }
      | undefined;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const group of groups) {
      const tolerance = Math.max(
        1.8,
        Math.min(group.fontSize, item.fontSize) * 0.42,
      );
      const distance = Math.abs(group.y - item.y);
      if (distance <= tolerance && distance < closestDistance) {
        closest = group;
        closestDistance = distance;
      }
    }
    if (closest) {
      closest.items.push(item);
      closest.y =
        closest.items.reduce((sum, entry) => sum + entry.y, 0) /
        closest.items.length;
      closest.fontSize = Math.max(closest.fontSize, item.fontSize);
    } else {
      groups.push({ y: item.y, fontSize: item.fontSize, items: [item] });
    }
  }

  return groups
    .flatMap((group) => {
      const ordered = group.items.sort((left, right) => left.x - right.x);
      return splitBaselineSegments(ordered).map((segment) => ({
        text: joinLineItems(segment),
        x: segment[0].x,
        right: Math.max(...segment.map((item) => item.x + item.width)),
        y: group.y,
        fontSize: Math.max(...segment.map((item) => item.fontSize)),
      }));
    })
    .filter((line) => line.text);
}

function splitBaselineSegments(items: PositionedItem[]): PositionedItem[][] {
  const segments: PositionedItem[][] = [];
  let current: PositionedItem[] = [];
  for (const item of items) {
    const previous = current.at(-1);
    const gap = previous ? item.x - (previous.x + previous.width) : 0;
    const splitThreshold = previous
      ? Math.max(48, Math.max(previous.fontSize, item.fontSize) * 5.5)
      : Number.POSITIVE_INFINITY;
    if (previous && gap > splitThreshold) {
      segments.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length) segments.push(current);
  return segments;
}

function joinLineItems(items: PositionedItem[]): string {
  let text = "";
  let previous: PositionedItem | undefined;
  for (const item of items) {
    if (!previous) {
      text = item.text;
      previous = item;
      continue;
    }
    const gap = item.x - (previous.x + previous.width);
    const needsSpace =
      !text.endsWith(" ") &&
      !/^[,.;:!?%)}\]，。；：！？、]/u.test(item.text) &&
      !/(?:\(|\{|\[|\u201c)$/u.test(text) &&
      (gap > Math.max(0.8, Math.min(previous.fontSize, item.fontSize) * 0.08) ||
        shouldSeparateTokens(text, item.text));
    text += `${needsSpace ? " " : ""}${item.text}`;
    previous = item;
  }
  return text.replace(/[ \t]+/g, " ").trim();
}

function shouldSeparateTokens(left: string, right: string): boolean {
  return (
    /[\p{L}\p{N}]$/u.test(left) &&
    /^[\p{L}\p{N}]/u.test(right) &&
    !/[\u3400-\u9fff]$/u.test(left) &&
    !/^[\u3400-\u9fff]/u.test(right)
  );
}

function detectColumnModel(
  lines: LayoutLine[],
  suppliedPageWidth: number,
): ColumnModel | undefined {
  if (lines.length < 8) return undefined;
  const minX = Math.min(...lines.map((line) => line.x));
  const maxRight = Math.max(...lines.map((line) => line.right));
  const pageWidth = Math.max(suppliedPageWidth || 0, maxRight - minX, 1);
  const candidates = lines.filter(
    (line) => line.text.length >= 12 && line.right - line.x < pageWidth * 0.72,
  );
  if (candidates.length < 8) return undefined;

  let leftCenter = Math.min(...candidates.map((line) => line.x));
  let rightCenter = Math.max(...candidates.map((line) => line.x));
  if (rightCenter - leftCenter < pageWidth * 0.24) return undefined;

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const left: number[] = [];
    const right: number[] = [];
    for (const line of candidates) {
      if (Math.abs(line.x - leftCenter) <= Math.abs(line.x - rightCenter)) {
        left.push(line.x);
      } else {
        right.push(line.x);
      }
    }
    if (!left.length || !right.length) return undefined;
    leftCenter = average(left);
    rightCenter = average(right);
  }

  const leftLines = candidates.filter(
    (line) => Math.abs(line.x - leftCenter) <= Math.abs(line.x - rightCenter),
  );
  const rightLines = candidates.filter((line) => !leftLines.includes(line));
  if (
    leftLines.length < Math.max(3, candidates.length * 0.2) ||
    rightLines.length < Math.max(3, candidates.length * 0.2) ||
    rightCenter - leftCenter < pageWidth * 0.24
  ) {
    return undefined;
  }
  const split =
    (Math.max(...leftLines.map((line) => line.right)) +
      Math.min(...rightLines.map((line) => line.x))) /
    2;
  return { split, pageWidth };
}

function orderTwoColumnLines(
  lines: LayoutLine[],
  model: ColumnModel,
): LayoutLine[] {
  const margin = model.pageWidth * 0.035;
  const spanning = lines
    .filter(
      (line) =>
        line.x < model.split - margin && line.right > model.split + margin,
    )
    .sort(compareVisualLines);
  const columnLines = lines.filter((line) => !spanning.includes(line));
  const output: LayoutLine[] = [];
  let upperBoundary = Number.POSITIVE_INFINITY;

  for (const separator of spanning) {
    output.push(
      ...orderColumnBand(
        columnLines.filter(
          (line) => line.y < upperBoundary && line.y > separator.y,
        ),
        model.split,
      ),
      separator,
    );
    upperBoundary = separator.y;
  }
  output.push(
    ...orderColumnBand(
      columnLines.filter((line) => line.y < upperBoundary),
      model.split,
    ),
  );
  return output;
}

function orderColumnBand(lines: LayoutLine[], split: number): LayoutLine[] {
  const left = lines.filter((line) => line.x < split).sort(compareVisualLines);
  const right = lines
    .filter((line) => line.x >= split)
    .sort(compareVisualLines);
  return [...left, ...right];
}

function renderReadableParagraphs(lines: LayoutLine[]): string {
  if (!lines.length) return "";
  const medianFontSize = median(lines.map((line) => line.fontSize)) || 10;
  const paragraphs: string[] = [];
  let paragraph = "";
  let previous: LayoutLine | undefined;

  for (const line of lines) {
    const heading = looksLikeHeading(line, medianFontSize);
    const verticalGap = previous ? Math.abs(previous.y - line.y) : 0;
    const columnJump =
      previous &&
      Math.abs(previous.x - line.x) > Math.max(90, medianFontSize * 12) &&
      line.y >= previous.y;
    const paragraphBreak =
      !previous ||
      heading ||
      looksLikeHeading(previous, medianFontSize) ||
      verticalGap > Math.max(medianFontSize * 1.65, 14) ||
      columnJump ||
      line.x - (previous?.x ?? line.x) > medianFontSize * 1.5;

    if (paragraphBreak && paragraph) {
      paragraphs.push(paragraph.trim());
      paragraph = "";
    }
    paragraph = appendWrappedLine(paragraph, line.text);
    if (heading) {
      paragraphs.push(paragraph.trim());
      paragraph = "";
    }
    previous = line;
  }
  if (paragraph) paragraphs.push(paragraph.trim());
  return normalizePdfPageText(paragraphs.filter(Boolean).join("\n\n"));
}

function looksLikeHeading(line: LayoutLine, medianFontSize: number): boolean {
  const text = line.text.trim();
  if (!text || text.length > 160) return false;
  if (line.fontSize >= medianFontSize * 1.18) return true;
  if (
    /^(?:abstract|introduction|background|methods?|methodology|results?|discussion|conclusions?|references|acknowledg(?:e)?ments?|appendix)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  return (
    text.length <= 80 &&
    /^[A-Z\d][A-Z\d\s.,:;()/-]{4,}$/u.test(text) &&
    /[A-Z]/.test(text)
  );
}

function appendWrappedLine(current: string, next: string): string {
  if (!current) return next;
  if (/[\p{L}]-$/u.test(current) && /^\p{Ll}/u.test(next)) {
    return `${current.slice(0, -1)}${next}`;
  }
  if (/[\u3400-\u9fff]$/u.test(current) && /^[\u3400-\u9fff]/u.test(next)) {
    return `${current}${next}`;
  }
  return `${current} ${next}`;
}

function compareVisualLines(left: LayoutLine, right: LayoutLine): number {
  return right.y - left.y || left.x - right.x;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}
