import {
  normalizeMarkdownScriptTags,
  renderMarkdownScriptSyntax,
} from "../../shared/markdownScripts";

const DISPLAY_MATH_BLOCK =
  /(^|\n)([ \t]*)\\{1,2}\[[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\\{1,2}\][ \t]*(?=\r?\n|$)/g;
const DISPLAY_MATH_INLINE = /[ \t]*\\{1,2}\[([^\n]*?)\\{1,2}\][ \t]*/g;
const INLINE_MATH = /\\{1,2}\(([^\n]*?)\\{1,2}\)/g;

export function normalizeMarkdownMath(content: string): string {
  const displayBlocks = normalizeMarkdownScriptTags(content).replace(
    DISPLAY_MATH_BLOCK,
    (_match, linePrefix: string, indentation: string, expression: string) => {
      const math = normalizeDisplayMath(expression)
        .split("\n")
        .map((line) => `${indentation}${line}`)
        .join("\n");
      return `${linePrefix}${indentation}$$\n${math}\n${indentation}$$`;
    },
  );
  const inlineDisplays = displayBlocks.replace(
    DISPLAY_MATH_INLINE,
    (_match, expression: string) =>
      `\n\n$$\n${normalizeLatexEscapes(expression)}\n$$\n\n`,
  );
  const normalized = inlineDisplays.replace(
    INLINE_MATH,
    (_match, expression: string) => `$${normalizeLatexEscapes(expression)}$`,
  );
  return renderMarkdownScriptSyntax(normalized);
}

function normalizeLatexEscapes(expression: string): string {
  return expression
    .trim()
    .replace(/\\\\([a-zA-Z]+)/g, (_match, command: string) => `\\${command}`);
}

function normalizeDisplayMath(expression: string): string {
  const lines = expression.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const indentation = lines
    .filter((line) => line.trim())
    .map((line) => line.match(/^[ \t]*/)?.[0].length ?? 0);
  const commonIndentation = indentation.length ? Math.min(...indentation) : 0;
  return normalizeLatexEscapes(
    lines.map((line) => line.slice(commonIndentation)).join("\n"),
  );
}
