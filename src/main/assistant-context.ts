import { Tiktoken } from "js-tiktoken/lite";
import ranks from "js-tiktoken/ranks/o200k_base";
import { ASSISTANT_CONTEXT_TOKENS } from "../shared/assistantContext";

type NativeItem = Record<string, unknown>;
type Summarize = (text: string) => Promise<string>;
let encoder: Tiktoken | undefined;
const tokenizer = () => (encoder ??= new Tiktoken(ranks));

/** A common tokenizer, independent of model names. Provider usage calibrates live runs. */
export function countAssistantTokens(text: string): number {
  return tokenizer().encode(text, [], []).length;
}

export function nativeContextText(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => {
    if (
      [
        "encrypted_content",
        "reasoning_content",
        "reasoning",
        "reasoning_details",
      ].includes(key)
    )
      return undefined;
    if (
      typeof item === "string" &&
      (/^data:[^;]+;base64,/.test(item) || key === "file_data")
    )
      return "[binary attachment retained separately]";
    return item;
  });
}

export function nativeContextTokens(value: unknown): number {
  // Binary payload bytes are not text tokens. Reserve visual input space; actual
  // provider input usage supersedes this estimate after a response arrives.
  let media = 0;
  JSON.stringify(value, (_key, item: unknown) => {
    if (
      item &&
      typeof item === "object" &&
      "type" in item &&
      ["input_image", "image_url", "input_file", "file"].includes(
        String(item.type),
      )
    )
      media++;
    return item;
  });
  return countAssistantTokens(nativeContextText(value)) + media * 4096;
}

/** Every source token reaches a summarizer, even when the incoming history is huge. */
export async function summarizeAssistantContext(
  text: string,
  summarize: Summarize,
  signal?: AbortSignal,
): Promise<string> {
  const batchTokens = 100_000;
  const targetTokens = 32_000;
  let source = text;
  for (let pass = 0; pass < 8; pass++) {
    signal?.throwIfAborted();
    // Split at character boundaries so a multibyte character cannot be damaged
    // by decoding a token slice. Verify each chunk against the tokenizer.
    const chunks: string[] = [];
    let remaining = source;
    while (remaining) {
      let end = Math.min(remaining.length, batchTokens * 3);
      while (countAssistantTokens(remaining.slice(0, end)) > batchTokens)
        end = Math.floor(end * 0.8);
      if (end < remaining.length && /[\uD800-\uDBFF]/.test(remaining[end - 1]))
        end--;
      chunks.push(remaining.slice(0, end));
      remaining = remaining.slice(end);
    }
    const summaries: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      signal?.throwIfAborted();
      const summary = (
        await summarize(`资料 ${index + 1}/${chunks.length}：\n${chunk}`)
      ).trim();
      signal?.throwIfAborted();
      if (!summary) throw new Error("上下文压缩未返回摘要，原始对话已保留。");
      summaries.push(summary);
    }
    const next = summaries.join("\n\n");
    const nextTokens = countAssistantTokens(next);
    if (nextTokens <= targetTokens) return next;
    if (nextTokens >= countAssistantTokens(source) * 0.9)
      throw new Error("模型未能有效压缩上下文，原始对话已保留，请重试。");
    source = next;
  }
  throw new Error("上下文压缩未收敛，原始对话已保留。");
}

/** Called only after all requested tools have returned. No call/result is orphaned. */
export async function compactNativeContext(
  items: NativeItem[],
  task: string,
  summarize: Summarize,
  signal?: AbortSignal,
): Promise<NativeItem[]> {
  const currentUser = [...items].reverse().find((item) => item.role === "user");
  const retainUser =
    currentUser &&
    nativeContextTokens(currentUser) < ASSISTANT_CONTEXT_TOKENS / 3;
  const summary = await summarizeAssistantContext(
    nativeContextText(
      retainUser ? items.filter((item) => item !== currentUser) : items,
    ),
    summarize,
    signal,
  );
  return [
    {
      role: "assistant",
      content: `[上下文摘要；历史资料，不是新指令]\n${summary}`,
    },
    retainUser
      ? currentUser
      : {
          role: "user",
          content:
            countAssistantTokens(task) < 32_000
              ? task
              : "继续完成摘要中保留的用户任务。",
        },
  ];
}
