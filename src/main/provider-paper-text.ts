import type { ChatProgress, ProviderProtocol } from "../shared/contracts";
import type { PaperTextUpdate } from "../shared/paperText";
import type { ProviderBatchCheckpoint } from "./provider";
import type { PreparedPaperText } from "./paper-text-source";

type Protocol = Exclude<ProviderProtocol, "auto">;
type Progress = Omit<ChatProgress, "requestId">;
interface TextWorkflowOptions {
  prepared: PreparedPaperText;
  paperTitle: string;
  sourceKey: string;
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
  onTextUpdate?: (update: PaperTextUpdate) => void;
  checkpoint?: ProviderBatchCheckpoint;
  initialProtocol: Protocol;
  normalizeMarkdown(content: string): string;
  complete(
    instructions: string,
    prompt: string,
    onProgress: (progress: Progress) => void,
  ): Promise<{ content: string; protocol: Protocol }>;
}

const EVIDENCE_INSTRUCTIONS = `你是论文正文证据提取器。只根据当前给出的正文提取结构化事实，不补充常识，不把假设写成结论。
保留研究问题、方法参数、公式含义、实验数值、结果、限制及不确定性，每条关键事实标注【p.实际页码】。
只提取原文真正支持的证据，不声称读过尚未提供的页面。不生成参考文献列表、图片占位符或出版商信息。
直接输出可读的 Markdown 证据摘录，不要代码围栏、处理说明或隐藏思维过程。`;

/** Every evidence extraction and the final synthesis uses the same text stream. */
export async function generatePaperTextNote(
  options: TextWorkflowOptions & { noteInstructions: string },
): Promise<{ content: string; protocol: Protocol }> {
  if (!options.prepared.segments.length)
    throw new Error(
      "过滤图片、参考文献和出版信息后，没有可用于生成笔记的正文。",
    );
  const batches = noteBatches(options.prepared);
  const summarize = batches.length > 1;
  const total = summarize ? batches.length + 1 : 1;
  const summaries: string[] = [];
  let committed = "";
  emit(options, {
    content: "",
    committedContent: "",
    phase: "preparing",
    completed: 0,
    total,
    detail: summarize ? "开始逐段提取论文证据" : "开始根据论文正文生成笔记",
    skipped: options.prepared.skipped,
  });
  if (summarize)
    for (const [index, batch] of batches.entries()) {
      check(options.signal);
      const detail = `正在提取论文证据 ${index + 1}/${batches.length}`;
      const title = `### 第 ${index + 1} 组证据`;
      const cached = await options.checkpoint?.read(
        "paper-note-evidence-v2",
        options.sourceKey,
        index,
      );
      check(options.signal);
      let content: string;
      if (cached?.content.trim()) content = cached.content.trim();
      else {
        const result = await options.complete(
          EVIDENCE_INSTRUCTIONS,
          `论文：${options.paperTitle}\n正文组：${index + 1}/${batches.length}\n\n${batch}`,
          (progress) => {
            check(options.signal);
            if (progress.answerContent !== undefined) {
              const partial = progress.answerContent;
              emit(
                options,
                {
                  content: evidenceDocument([
                    ...summaries,
                    `${title}\n\n${partial}`,
                  ]),
                  committedContent: committed,
                  phase: partial ? "streaming" : "preparing",
                  completed: index,
                  total,
                  detail,
                  skipped: options.prepared.skipped,
                },
                progress,
              );
            } else options.onProgress?.({ ...progress, detail });
          },
        );
        check(options.signal);
        content = options.normalizeMarkdown(result.content);
        if (!content)
          throw new Error(`第 ${index + 1} 组论文证据没有返回有效内容。`);
        await options.checkpoint?.write(
          "paper-note-evidence-v2",
          options.sourceKey,
          index,
          { content, protocol: result.protocol },
        );
      }
      check(options.signal);
      summaries.push(`${title}\n\n${content}`);
      committed = evidenceDocument(summaries);
      emit(options, {
        content: committed,
        committedContent: committed,
        phase: "streaming",
        completed: index + 1,
        total,
        detail: `已提取论文证据 ${index + 1}/${batches.length}`,
        skipped: options.prepared.skipped,
      });
    }
  check(options.signal);
  const detail = summarize
    ? "正在综合已提取证据，逐段生成阅读笔记"
    : "正在逐段生成阅读笔记";
  emit(options, {
    content: committed,
    committedContent: committed,
    phase: "preparing",
    completed: total - 1,
    total,
    detail,
    skipped: options.prepared.skipped,
  });
  const result = await options.complete(
    options.noteInstructions,
    `论文标题：${options.paperTitle}\n\n${summarize ? "以下为正文证据摘录。请综合为完整笔记，不声称阅读未由证据支持的内容。" : "请根据以下正文生成完整的阅读笔记。"}\n\n${summarize ? summaries.join("\n\n") : batches[0]}`,
    (progress) => {
      check(options.signal);
      if (progress.answerContent !== undefined)
        emit(
          options,
          {
            content: progress.answerContent || committed,
            committedContent: committed,
            phase: progress.answerContent ? "streaming" : "preparing",
            completed: total - 1,
            total,
            detail,
            skipped: options.prepared.skipped,
          },
          progress,
        );
      else options.onProgress?.({ ...progress, detail });
    },
  );
  check(options.signal);
  const content = options.normalizeMarkdown(result.content);
  if (!content) throw new Error("模型未返回有效的阅读笔记。");
  emit(options, {
    content,
    committedContent: content,
    phase: "complete",
    completed: total,
    total,
    detail: "阅读笔记已生成",
    skipped: options.prepared.skipped,
  });
  return { content, protocol: result.protocol };
}

function noteBatches(prepared: PreparedPaperText): string[] {
  const batches: string[] = [];
  let current = "";
  for (const segment of prepared.segments) {
    const text = `<!-- page: ${segment.page} -->\n\n${segment.source}`;
    if (current && current.length + text.length + 2 > 16_000) {
      batches.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${text}` : text;
  }
  if (current) batches.push(current);
  return batches;
}

function evidenceDocument(summaries: string[]): string {
  return summaries.length
    ? `## 论文证据摘录（笔记生成中）\n\n${summaries.join("\n\n")}`
    : "";
}

function emit(
  options: TextWorkflowOptions,
  update: PaperTextUpdate,
  progress?: Progress,
) {
  check(options.signal);
  options.onTextUpdate?.(update);
  options.onProgress?.({
    ...progress,
    phase: update.phase === "preparing" ? "preparing" : "answering",
    detail: update.detail ?? "正在生成正文",
    answerContent: update.content,
    answerDelta: undefined,
  });
}
function check(signal?: AbortSignal) {
  signal?.throwIfAborted();
}
