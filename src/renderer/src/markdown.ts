const MATH_DELIMITER_REWRITES = [
  { pattern: /\\\\\[([\s\S]*?)\\\\\]/g, display: true },
  { pattern: /\\\[([\s\S]*?)\\\]/g, display: true },
  { pattern: /\\\\\(([\s\S]*?)\\\\\)/g, display: false },
  { pattern: /\\\(([\s\S]*?)\\\)/g, display: false },
] as const;

export function normalizeMarkdownMath(content: string): string {
  return MATH_DELIMITER_REWRITES.reduce((normalized, rewrite) => {
    return normalized.replace(rewrite.pattern, (_match, expression: string) => {
      const math = normalizeLatexEscapes(expression);
      if (rewrite.display) return `$$\n${math}\n$$`;
      return `$${math}$`;
    });
  }, content);
}

function normalizeLatexEscapes(expression: string): string {
  return expression
    .trim()
    .replace(/\\\\([a-zA-Z]+)/g, (_match, command: string) => `\\${command}`);
}
