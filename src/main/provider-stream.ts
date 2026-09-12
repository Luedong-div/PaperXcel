import type { ChatProgress, ProviderProtocol } from "../shared/contracts";

type Progress = Omit<ChatProgress, "requestId">;
type Protocol = Exclude<ProviderProtocol, "auto">;

interface TextPart {
  outputIndex: number;
  partIndex: number;
  raw: string;
  parser: ThinkMarkupStreamParser;
  parsed: ThinkMarkupStreamResult;
}

/** A single provider attempt. Snapshots are authoritative; deltas are append-only hints. */
export class ProviderStreamAccumulator {
  private readonly answers = new Map<string, TextPart>();
  private readonly summaries = new Map<string, TextPart>();
  private readonly thoughts = new Map<string, TextPart>();
  private readonly itemIndexes = new Map<string, number>();
  private readonly sequences = new Set<number>();
  private explicitReasoning = "";
  private answerContent = "";
  private reasoningContent = "";
  private reasoningObserved = false;
  private terminal = false;
  private finished = false;
  private usagePayload: unknown;

  constructor(
    private readonly protocol: Protocol,
    private readonly onProgress: (progress: Progress) => void,
  ) {}

  push(event: unknown): void {
    if (this.finished) return;
    const record = objectRecord(event);
    if (!record) return;
    if (objectRecord(record.usage)) this.usagePayload = record;
    if (this.protocol === "responses") this.pushResponse(record);
    else this.pushChat(record);
    this.publish();
  }

  finish(): {
    content: string;
    reasoningContent: string;
    reasoningObserved: boolean;
    usagePayload: unknown;
  } {
    if (!this.terminal) {
      throw new Error(
        "模型连接在返回完成标记前中断，已收到的内容可能不完整，请重试。",
      );
    }
    if (!this.finished) {
      for (const part of this.answers.values())
        part.parsed = part.parser.finish();
      this.publish();
      this.finished = true;
    }
    if (!this.answerContent.trim()) {
      throw new Error(
        `${this.protocol === "responses" ? "Responses API" : "模型"} 未返回可识别的文本内容。`,
      );
    }
    return {
      content: this.answerContent,
      reasoningContent: this.reasoningContent,
      reasoningObserved: this.reasoningObserved,
      usagePayload: this.usagePayload,
    };
  }

  private pushResponse(record: Record<string, unknown>): void {
    const type = text(record.type);
    if (typeof record.sequence_number === "number") {
      if (this.sequences.has(record.sequence_number)) return;
      this.sequences.add(record.sequence_number);
    }
    if (
      type === "error" ||
      type === "response.failed" ||
      type === "response.incomplete"
    ) {
      throw responseFailure(record);
    }
    if (this.terminal) return;
    const item = objectRecord(record.item);
    if (
      item &&
      typeof item.id === "string" &&
      typeof record.output_index === "number"
    ) {
      this.itemIndexes.set(item.id, record.output_index);
    }
    if (type === "response.completed") {
      const response = objectRecord(record.response);
      assertResponsesCompletion(response);
      this.applyResponseSnapshot(response);
      if (objectRecord(response?.usage)) this.usagePayload = response;
      this.terminal = true;
      return;
    }
    if (type === "response.output_item.done" && item) {
      this.applyOutputItem(item, this.outputIndex(record));
      return;
    }
    if (type === "response.content_part.done") {
      const part = objectRecord(record.part);
      if (part && (part.type === "output_text" || part.type === "refusal")) {
        this.updatePart(
          this.answers,
          record,
          streamText(part.text ?? part.refusal),
          true,
        );
      }
      return;
    }
    if (type === "response.reasoning_summary_part.done") {
      const part = objectRecord(record.part);
      if (part)
        this.updatePart(
          this.summaries,
          record,
          streamText(part.text),
          true,
          true,
        );
      return;
    }
    if (
      type.startsWith("response.reasoning") &&
      /\.(?:delta|done)$/.test(type)
    ) {
      const summary = type.includes("summary");
      const done = type.endsWith(".done");
      this.updatePart(
        summary ? this.summaries : this.thoughts,
        record,
        streamText(done ? record.text : record.delta),
        done,
        summary,
      );
      return;
    }
    if (/^response\.(?:output_text|refusal)\.(?:delta|done)$/.test(type)) {
      const done = type.endsWith(".done");
      this.updatePart(
        this.answers,
        record,
        streamText(done ? (record.text ?? record.refusal) : record.delta),
        done,
      );
    }
  }

  private pushChat(record: Record<string, unknown>): void {
    if (record.error) throw responseFailure(record);
    // Usage-only chunks are allowed after the selected choice has finished.
    if (this.terminal) return;
    const choices = Array.isArray(record.choices) ? record.choices : [];
    const choice =
      choices.map(objectRecord).find((value) => value?.index === 0) ??
      choices
        .map(objectRecord)
        .find((value) => value && value.index === undefined);
    if (!choice) return;
    const delta = objectRecord(choice.delta);
    const message = objectRecord(choice.message);
    const value = delta ?? message;
    if (value) {
      const reasoning = extractReasoningDelta(value);
      if (delta) this.explicitReasoning += reasoning;
      else this.explicitReasoning = reasoning;
      const content = streamText(value.content) || streamText(value.refusal);
      if (content || message)
        this.updatePart(this.answers, {}, content, !delta);
    }
    const finishReason = text(choice.finish_reason);
    if (!finishReason) return;
    // Publish the last partial text before surfacing an incomplete/filtered result.
    this.publish();
    assertChatCompletionFinishReason(finishReason);
    this.terminal = true;
  }

  private applyResponseSnapshot(response?: Record<string, unknown>): void {
    if (!response) return;
    const output = Array.isArray(response.output) ? response.output : [];
    const hasText = output.some((value) => {
      const item = objectRecord(value);
      return (
        item &&
        (item.type === "message" ||
          item.type === "output_text" ||
          item.type === "text")
      );
    });
    if (hasText) this.answers.clear();
    if (output.some((value) => objectRecord(value)?.type === "reasoning")) {
      this.summaries.clear();
      this.thoughts.clear();
    }
    output.forEach((value, index) => {
      const item = objectRecord(value);
      if (item) this.applyOutputItem(item, index);
    });
    if (typeof response.output_text === "string" && response.output_text) {
      this.answers.clear();
      this.updatePart(this.answers, {}, response.output_text, true);
    }
  }

  private applyOutputItem(
    item: Record<string, unknown>,
    outputIndex: number,
  ): void {
    const reasoning = item.type === "reasoning";
    if (reasoning) {
      for (const [field, target] of [
        ["summary", this.summaries],
        ["content", this.thoughts],
      ] as const) {
        const parts = Array.isArray(item[field]) ? item[field] : [];
        parts.forEach((part, partIndex) =>
          this.updatePart(
            target,
            {
              output_index: outputIndex,
              content_index: partIndex,
            },
            streamText(part),
            true,
          ),
        );
      }
      return;
    }
    if (item.type === "output_text" || item.type === "text") {
      this.updatePart(
        this.answers,
        { output_index: outputIndex },
        streamText(item.text),
        true,
      );
      return;
    }
    if (item.type !== "message" && item.type !== undefined) return;
    const parts = Array.isArray(item.content) ? item.content : [];
    parts.forEach((value, partIndex) => {
      const part = objectRecord(value);
      if (
        !part ||
        (part.type &&
          !["text", "output_text", "refusal"].includes(text(part.type)))
      )
        return;
      this.updatePart(
        this.answers,
        {
          output_index: outputIndex,
          content_index: partIndex,
        },
        streamText(part.text ?? part.refusal),
        true,
      );
    });
  }

  private outputIndex(record: Record<string, unknown>): number {
    return typeof record.output_index === "number"
      ? record.output_index
      : (this.itemIndexes.get(text(record.item_id)) ?? 0);
  }

  private updatePart(
    parts: Map<string, TextPart>,
    record: Record<string, unknown>,
    value: string,
    snapshot: boolean,
    summary = false,
  ): void {
    const outputIndex = this.outputIndex(record);
    const index = summary ? record.summary_index : record.content_index;
    const partIndex = typeof index === "number" ? index : 0;
    const key = `${outputIndex}:${partIndex}`;
    let part = parts.get(key);
    const raw = snapshot ? value : (part?.raw ?? "") + value;
    if (!part || !raw.startsWith(part.raw)) {
      const parser = new ThinkMarkupStreamParser();
      part = {
        outputIndex,
        partIndex,
        raw: "",
        parser,
        parsed: parser.push(""),
      };
      parts.set(key, part);
    }
    part.parsed = part.parser.push(raw.slice(part.raw.length), snapshot);
    part.raw = raw;
  }

  private publish(): void {
    const answerParts = orderedParts(this.answers);
    const answerContent = answerParts
      .map((part) => part.parsed.content)
      .join("\n");
    const explicit =
      joinReasoning(this.summaries) ||
      joinReasoning(this.thoughts) ||
      this.explicitReasoning;
    const reasoningContent = combineReasoningContent(
      explicit,
      ...answerParts.map((part) => part.parsed.reasoningContent),
    );
    const answerChanged = answerContent !== this.answerContent;
    const reasoningChanged = reasoningContent !== this.reasoningContent;
    if (!answerChanged && !reasoningChanged) return;
    const answerDelta =
      answerChanged && answerContent.startsWith(this.answerContent)
        ? answerContent.slice(this.answerContent.length)
        : undefined;
    const reasoningDelta =
      reasoningChanged && reasoningContent.startsWith(this.reasoningContent)
        ? reasoningContent.slice(this.reasoningContent.length)
        : undefined;
    this.answerContent = answerContent;
    this.reasoningContent = reasoningContent;
    this.reasoningObserved ||= Boolean(reasoningContent.trim());
    this.onProgress({
      phase: answerContent
        ? "answering"
        : reasoningContent
          ? "thinking"
          : "waiting",
      detail: answerContent
        ? "正在生成回答"
        : reasoningContent
          ? "正在接收模型推理内容"
          : "等待模型响应",
      ...(answerChanged
        ? { answerContent, ...(answerDelta ? { answerDelta } : {}) }
        : {}),
      reasoningContent,
      reasoningObserved: this.reasoningObserved,
      ...(reasoningDelta ? { reasoningDelta } : {}),
    });
  }
}

function orderedParts(parts: Map<string, TextPart>): TextPart[] {
  return [...parts.values()].sort(
    (left, right) =>
      left.outputIndex - right.outputIndex || left.partIndex - right.partIndex,
  );
}

function joinReasoning(parts: Map<string, TextPart>): string {
  return orderedParts(parts)
    .map((part) => part.raw.trim())
    .filter(Boolean)
    .join("\n\n");
}

function responseFailure(record: Record<string, unknown>): Error {
  const response = objectRecord(record.response);
  const error =
    objectRecord(record.error) ?? objectRecord(response?.error) ?? record;
  const reason = text(objectRecord(response?.incomplete_details)?.reason);
  const message =
    text(error.message) ||
    (record.type === "response.incomplete"
      ? `模型提前停止，回答不完整${reason ? `（${reason}）` : ""}。`
      : "模型生成回答失败。");
  return Object.assign(new Error(message), {
    code: error.code,
    status: error.status ?? record.status,
    error,
  });
}

export function assertResponsesCompletion(value: unknown): void {
  const response = objectRecord(value);
  if (!response) return;
  const status = text(response.status);
  if (
    response.error ||
    ["failed", "incomplete", "cancelled"].includes(status)
  ) {
    throw responseFailure({ type: `response.${status}`, response });
  }
}

export function assertChatCompletionFinishReason(value: unknown): void {
  const finishReason = text(value);
  if (!finishReason || finishReason === "stop") return;
  if (finishReason === "length")
    throw new Error("模型回答超过输出长度限制，内容不完整。");
  if (finishReason === "content_filter")
    throw new Error("模型回答被服务商内容过滤中止，内容不完整。");
  throw new Error(`模型以 ${finishReason} 结束，未完成文本回答。`);
}

export function combineReasoningContent(...parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part, index, values) => part && values.indexOf(part) === index)
    .join("\n\n");
}

export function extractReasoningDelta(record: Record<string, unknown>): string {
  return (
    streamText(record.reasoning_content) ||
    streamText(record.reasoning) ||
    streamText(record.thinking) ||
    streamText(record.reasoning_details)
  );
}

export function streamText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(streamText).join("");
  const record = objectRecord(value);
  return typeof record?.text === "string" ? record.text : "";
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

interface ThinkMarkupStreamResult {
  content: string;
  reasoningContent: string;
  contentDelta: string;
  reasoningDelta: string;
}

export class ThinkMarkupStreamParser {
  private mode: "content" | "reasoning" = "content";
  private buffer = "";
  private content = "";
  private reasoningContent = "";

  push(chunk: string, final = false): ThinkMarkupStreamResult {
    this.buffer += chunk;
    let contentDelta = "";
    let reasoningDelta = "";

    const appendContent = (value: string): void => {
      if (!value) return;
      this.content += value;
      contentDelta += value;
    };
    const appendReasoning = (value: string): void => {
      if (!value) return;
      this.reasoningContent += value;
      reasoningDelta += value;
    };

    while (this.buffer) {
      if (this.mode === "content") {
        const openTag = /<think\b[^>]*>/i.exec(this.buffer);
        const strayCloseTag = /<\/think\s*>/i.exec(this.buffer);
        const nextTag =
          openTag &&
          (!strayCloseTag ||
            (openTag.index ?? Number.POSITIVE_INFINITY) <
              (strayCloseTag.index ?? Number.POSITIVE_INFINITY))
            ? { kind: "open" as const, match: openTag }
            : strayCloseTag
              ? { kind: "close" as const, match: strayCloseTag }
              : undefined;

        if (nextTag) {
          const tagIndex = nextTag.match.index ?? 0;
          appendContent(this.buffer.slice(0, tagIndex));
          this.buffer = this.buffer.slice(tagIndex + nextTag.match[0].length);
          if (nextTag.kind === "open") this.mode = "reasoning";
          continue;
        }

        if (final) {
          appendContent(this.buffer);
          this.buffer = "";
          continue;
        }

        const holdIndex = incompleteThinkTagIndex(this.buffer, true);
        const flushLength = holdIndex < 0 ? this.buffer.length : holdIndex;
        if (flushLength > 0) {
          appendContent(this.buffer.slice(0, flushLength));
          this.buffer = this.buffer.slice(flushLength);
        }
        break;
      }

      const closeTag = /<\/think\s*>/i.exec(this.buffer);
      if (closeTag) {
        const tagIndex = closeTag.index ?? 0;
        appendReasoning(this.buffer.slice(0, tagIndex));
        this.buffer = this.buffer.slice(tagIndex + closeTag[0].length);
        this.mode = "content";
        continue;
      }

      if (final) {
        appendReasoning(this.buffer);
        this.buffer = "";
        continue;
      }

      const holdIndex = incompleteThinkTagIndex(this.buffer, false);
      const flushLength = holdIndex < 0 ? this.buffer.length : holdIndex;
      if (flushLength > 0) {
        appendReasoning(this.buffer.slice(0, flushLength));
        this.buffer = this.buffer.slice(flushLength);
      }
      break;
    }

    return {
      content: this.content,
      reasoningContent: this.reasoningContent,
      contentDelta,
      reasoningDelta,
    };
  }

  finish(): ThinkMarkupStreamResult {
    return this.push("", true);
  }
}

function incompleteThinkTagIndex(
  value: string,
  includeOpeningTag: boolean,
): number {
  const index = value.lastIndexOf("<");
  if (index < 0) return -1;
  const suffix = value.slice(index).toLowerCase();
  const possibleTags = includeOpeningTag ? ["<think", "</think"] : ["</think"];
  return possibleTags.some((tag) => {
    if (tag.startsWith(suffix)) return true;
    if (!suffix.startsWith(tag)) return false;
    const next = suffix[tag.length];
    return (
      next === undefined ||
      ((next === ">" || next === "/" || /\s/.test(next)) &&
        !suffix.includes(">"))
    );
  })
    ? index
    : -1;
}
