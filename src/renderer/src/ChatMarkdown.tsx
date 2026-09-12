import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { normalizeMarkdownMath } from "./markdown";

// Sanitize author HTML before KaTeX creates its own trusted HTML/MathML. In
// particular, incomplete tags arriving in a stream go through the same parser
// and sanitizer as the final answer; there is no separate raw-HTML fast path.
const markdownSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
    td: [...(defaultSchema.attributes?.td ?? []), "colSpan", "rowSpan"],
    th: [...(defaultSchema.attributes?.th ?? []), "colSpan", "rowSpan"],
  },
};

const remarkPlugins = [remarkGfm, remarkMath, remarkBreaks];
const rehypePlugins = [
  rehypeRaw,
  [rehypeSanitize, markdownSchema],
  [rehypeKatex, { trust: false, strict: "ignore" }],
] satisfies NonNullable<
  React.ComponentProps<typeof ReactMarkdown>["rehypePlugins"]
>;
const components: Components = {
  a: ({ node: _node, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer" />
  ),
};

export const ChatMarkdown = memo(function ChatMarkdown({
  content,
}: {
  content: string;
}): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={components}
    >
      {normalizeMarkdownMath(content)}
    </ReactMarkdown>
  );
});
