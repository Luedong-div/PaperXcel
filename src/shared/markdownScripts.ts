const HTML_SCRIPT_TAG = /<(sup|sub)\b[^>]*>([\s\S]*?)<\/\1>/gi;
const MARKDOWN_SUPERSCRIPT = /(?<!\^)\^([^\n^]+)\^(?!\^)/g;
const MARKDOWN_SUBSCRIPT = /(?<!~)~([^\n~]+)~(?!~)/g;

export function normalizeMarkdownScriptTags(content: string): string {
  return mapMarkdownProse(
    content,
    (prose) =>
      prose.replace(HTML_SCRIPT_TAG, (_match, tag: string, value: string) => {
        const marker = tag.toLowerCase() === "sup" ? "^" : "~";
        const normalized = value.trim();
        return normalized ? `${marker}${normalized}${marker}` : "";
      }),
    { includeScriptTags: true },
  );
}

export function renderMarkdownScriptSyntax(content: string): string {
  return mapMarkdownProse(content, (prose) =>
    prose
      .replace(MARKDOWN_SUPERSCRIPT, "<sup>$1</sup>")
      .replace(MARKDOWN_SUBSCRIPT, "<sub>$1</sub>"),
  );
}

/** Apply source extensions only to prose, keeping Markdown's literal regions intact. */
export function mapMarkdownProse(
  content: string,
  transform: (prose: string) => string,
  options: { includeMath?: boolean; includeScriptTags?: boolean } = {},
): string {
  let result = "";
  let proseStart = 0;
  let index = 0;
  while (index < content.length) {
    const rest = content.slice(index);
    let end = index;
    if (index === 0 || content[index - 1] === "\n") {
      const fence = rest.match(/^[ \t>]*(`{3,}|~{3,})[^\n]*(?:\n|$)/);
      if (fence) {
        const closing = new RegExp(
          `(?:^|\\n)[ \\t>]*${fence[1][0]}{${fence[1].length},}[ \\t]*(?:\\r?\\n|$)`,
        ).exec(rest.slice(fence[0].length));
        end = closing
          ? index + fence[0].length + closing.index + closing[0].length
          : content.length;
      } else {
        const literalLine = rest.match(
          /^(?:(?: {4}|\t)[^\n]*|[ \t]{0,3}\[[^\]\n]+\]:[^\n]*)(?:\n|$)/,
        );
        if (literalLine) end = index + literalLine[0].length;
      }
    }
    if (end === index) {
      const math = rest.match(/^(\${1,2}|\\{1,2}[([])/)?.[0];
      if (math) {
        const closing = math.startsWith("$")
          ? math
          : `${math.slice(0, -1)}${math.endsWith("(") ? ")" : "]"}`;
        end = findClosingDelimiter(content, index + math.length, closing);
        if (options.includeMath) {
          index = end;
          continue;
        }
      } else if (content[index] === "`") {
        const ticks = rest.match(/^`+/)![0];
        end = findClosingDelimiter(content, index + ticks.length, ticks);
      } else if (rest.startsWith("](")) {
        end = linkDestinationEnd(content, index + 2);
      } else if (rest.startsWith("<!--")) {
        const closing = content.indexOf("-->", index + 4);
        end = closing < 0 ? content.length : closing + 3;
      } else if (content[index] === "<") {
        const tag = rest.match(
          /^<\/?[A-Za-z][^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/,
        );
        if (tag) {
          end = index + tag[0].length;
          const verbatim = tag[0].match(/^<(code|pre|script|style)\b/i);
          if (verbatim) {
            const closing = new RegExp(`</${verbatim[1]}\\s*>`, "i").exec(
              content.slice(end),
            );
            end = closing
              ? end + closing.index + closing[0].length
              : content.length;
          } else if (
            options.includeScriptTags &&
            /^<(sup|sub)\b/i.test(tag[0])
          ) {
            const script = rest.match(/^<(sup|sub)\b[^>]*>([\s\S]*?)<\/\1>/i);
            if (script) {
              index += script[0].length;
              continue;
            }
          }
        } else if (/^<\/?[A-Za-z]/.test(rest)) {
          // An HTML attribute may be arriving over the stream; do not edit it.
          end = content.length;
        }
      } else if (content[index] === "\\" && index + 1 < content.length) {
        end = index + 2;
      } else {
        const url = rest.match(/^(?:https?:\/\/|www\.)[^\s<>]+/i);
        if (url) end = index + url[0].length;
      }
    }
    if (end > index) {
      result += transform(content.slice(proseStart, index));
      result += content.slice(index, end);
      index = end;
      proseStart = end;
    } else index++;
  }
  return result + transform(content.slice(proseStart));
}

function findClosingDelimiter(
  content: string,
  start: number,
  delimiter: string,
): number {
  for (let index = start; index < content.length; index++) {
    if (content.startsWith(delimiter, index)) {
      if (
        (delimiter.startsWith("$") || delimiter.startsWith("`")) &&
        (content[index - 1] === delimiter[0] ||
          content[index + delimiter.length] === delimiter[0])
      )
        continue;
      return index + delimiter.length;
    }
    if (content[index] === "\\") index++;
  }
  // An unfinished formula/code span is a literal until a later stream snapshot closes it.
  return content.length;
}

function linkDestinationEnd(content: string, start: number): number {
  let depth = 1;
  let quote = "";
  for (let index = start; index < content.length; index++) {
    const character = content[index];
    if (character === "\\") index++;
    else if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "(") depth++;
    else if (character === ")" && --depth === 0) return index + 1;
  }
  return content.length;
}
