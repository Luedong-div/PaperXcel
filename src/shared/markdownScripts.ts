const HTML_SCRIPT_TAG = /<(sup|sub)\b[^>]*>([\s\S]*?)<\/\1>/gi;
const MARKDOWN_SUPERSCRIPT = /\^([^\n^]+)\^/g;
const MARKDOWN_SUBSCRIPT = /~([^\n~]+)~/g;

export function normalizeMarkdownScriptTags(content: string): string {
  return content.replace(
    HTML_SCRIPT_TAG,
    (_match, tag: string, value: string) => {
      const marker = tag.toLowerCase() === "sup" ? "^" : "~";
      const normalized = value.trim();
      return normalized ? `${marker}${normalized}${marker}` : "";
    },
  );
}

export function renderMarkdownScriptSyntax(content: string): string {
  return content
    .replace(MARKDOWN_SUPERSCRIPT, "<sup>$1</sup>")
    .replace(MARKDOWN_SUBSCRIPT, "<sub>$1</sub>");
}
