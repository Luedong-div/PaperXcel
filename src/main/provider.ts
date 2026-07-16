import OpenAI from "openai";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type {
  AskPaperInput,
  AskPaperResult,
  ChatProgress,
  ChatMessage,
  CitationGraphEdge,
  CitationGraphNode,
  DocumentPageText,
  GeneratePaperNoteResult,
  LibraryAskHistoryMessage,
  LibraryAskResult,
  LibraryReview,
  ModelReasoningEffort,
  Paper,
  PaperNote,
  ProviderModel,
  ProviderProfileInput,
  ProviderProtocol,
} from "../shared/contracts";
import { normalizeCitationDoi } from "../shared/citationGraph";
import { extractCitations } from "../shared/citations";
import {
  extractLibraryCitations,
  type LibraryCitationSource,
} from "../shared/libraryCitations";
import {
  getProviderRequestId,
  isTransientProviderError,
  shouldFallbackToChatCompletions,
} from "../shared/providerCompat";
import { normalizeBaseUrl } from "./store";
import {
  readChatAttachmentDataUrl,
  type ResolvedChatAttachment,
} from "./chat-attachments";
import type {
  CitationReferenceSearchHint,
  CitationReferenceSearchRequest,
} from "./reference-resolver";

interface ProviderCredentials {
  name: string;
  baseUrl: string;
  model: string;
  protocol: ProviderProtocol;
  apiKey: string;
}

interface ProviderRequestOptions {
  signal?: AbortSignal;
  attachments?: ResolvedChatAttachment[];
  onProgress?: (progress: Omit<ChatProgress, "requestId">) => void;
}

interface KnowledgeRepairRequestOptions extends ProviderRequestOptions {
  cachedMarkdown?: string;
}

interface ProviderCompletionRequestOptions {
  timeoutMs?: number;
}

interface ProviderTextCompletion {
  content: string;
  reasoningContent?: string;
  attachmentInput?: "text-fallback";
}

const PAPER_ASSISTANT_SYSTEM_PROMPT = `你是 PaperXcel 中的文献助手。
当前论文会以原始文件，或由 PaperXcel 本地提取、保留页码标记的文本作为会话上下文。直接阅读提供的内容并完成用户提出的任务，不要套用固定分析模板。
无法从论文或附件确认的内容应明确说明，不要编造。默认使用用户的语言回答，并保留必要的英文术语、公式和单位。`;

const NOTE_SYSTEM_PROMPT = `你是 PaperXcel 的通用学术研究笔记助手。
请完整阅读随消息提供的论文文件或本地提取文本，并生成可继续编辑的 Markdown 阅读笔记。输入通常是完整 PDF；如果服务商无法接收 PDF，则会提供由 PaperXcel 本地解析生成、保留页面标记的 full.md。
规则：
1. 严格使用以下二级标题：研究问题与背景、研究对象与证据来源、方法与研究设计、关键假设与实施细节、主要结果与证据、局限性与适用范围、待核查问题。
2. 每个可验证事实在句末使用【p.页码】引用，不得编造页码、公式编号、参数或结论。
3. 按论文实际类型保留关键模型、公式、材料、数据集、样本、实验或计算条件、统计方法、软件、仪器、评价指标和单位，不适用的项目明确写“不适用”。
4. 对论文文件中未确认但应核查的栏目写“论文中未确认”，不要用常识补齐。
5. 明确区分论文结论、作者假设和你的推断；推断必须标为“推断”。
6. 使用简洁中文，不要输出代码围栏，也不要重复论文标题。`;

const LIBRARY_QA_SYSTEM_PROMPT = `你是 PaperXcel 的全库证据问答助手。
规则：
1. 只能根据提供的跨文献检索片段回答问题，不得把模型常识写成论文结论。
2. 每个关键事实必须使用【P1 p.页码】格式引用；只能引用上下文中真实存在的论文编号和页码。
3. 明确区分单篇论文结论与跨文献综合；综合判断必须标为“综合推断”并给出多篇支持证据。
4. 比较不同研究对象、样本、材料、数据集、任务、条件或评价指标时，先说明可比性。
5. 当前证据不足时直接说明，并指出还需要检索的主题、章节或论文。
6. 历史对话只用于理解追问和保持上下文；本轮新增事实与引用必须来自本轮提供的索引片段。
7. 默认使用简洁中文，保留英文术语、公式、单位和不确定性，不要输出代码围栏。`;

const KNOWLEDGE_MARKDOWN_REPAIR_SYSTEM_PROMPT = `你是 PaperXcel 的学术论文 Markdown 转换与修复引擎。你会收到当前论文的原始 PDF；如果服务商不支持 PDF 文件输入，则会收到 PaperXcel 本地提取的 full.md 文本。
请完整阅读输入，并输出可直接覆盖当前全文缓存的完整 Markdown。
规则：
1. 必须返回整篇论文，不得只返回修改片段，不得总结、翻译、删节、评论或补充源文件中不存在的信息。
2. 保持标题、作者、摘要、章节、段落、脚注、致谢、附录、图表题、参考文献和阅读顺序。
3. 按 PDF 实际页面插入 \`## 第 N 页\` 页面标题，页码从 PDF 第 1 页开始，不得编造、删除、跳过或重排页面。
4. 修复标题层级、段落断行、连字符断词、乱码、重复页眉页脚和明显的版面读取顺序问题。
5. 公式使用 LaTeX：行内公式用 \`$...$\`，独立公式用 \`$$...$$\`。保留公式编号、符号、上下标和单位。
6. 表格优先使用 Markdown 表格；复杂表格可使用 HTML table，但不得丢失单元格、表注或数值。
7. 保留图题、表题、引用、DOI、数字和可辨认的图内文字；无法确认的内容按源文件保留，不得猜测。
8. 不要声称直接修改了本机文件；PaperXcel 会在校验输出后负责写回。
9. 只输出完整 Markdown 正文，不要使用包裹全文的代码围栏，不要输出 JSON，也不要添加处理说明。`;

const KNOWLEDGE_CITATION_REPAIR_SYSTEM_PROMPT = `你是 PaperXcel 的引文元数据校对器。
根据当前论文的参考文献页面，只校对输入中已经存在的外部文献节点，不得新增或删除节点，不得新增、删除或修改引用边。
规则：
1. 只有参考文献证据明确支持时才能修正 title、authors、journal、year、doi、volume、issue、pages。
2. 不确定时不要返回该节点；不得根据常识或标题猜测 DOI。
3. id 必须原样返回，confidence 使用 0 到 1。
4. 输出严格 JSON，不要使用 Markdown 代码围栏：
{"corrections":[{"id":"external:W123","confidence":0.95,"title":"...","authors":["..."],"year":2020,"doi":"10.xxxx/xxxx"}]}`;

const LIBRARY_REVIEW_BATCH_SYSTEM_PROMPT = `你是学术文献综述的资料分析助手。根据给出的论文阅读笔记，提炼主题、方法、结论、分歧、演进关系和研究空白。
必须保留论文编号，例如【P1】。不要声称阅读了未提供的论文全文，不得虚构引用关系。使用简洁中文，保留英文术语。`;

const LIBRARY_REVIEW_SYSTEM_PROMPT = `你是 PaperXcel 的全库文献综述助手。根据论文阅读笔记、分组分析和引文关系生成一份可继续编辑的 Markdown 综述。
必须使用以下二级标题：研究范围、主题脉络、方法与理论演进、核心共识、主要分歧、引文结构、研究空白、建议阅读路径。
规则：
1. 每个关键判断使用【P1】或【P1、P2】标注支持它的库内论文。
2. 明确区分作者结论与跨文献推断；跨文献推断必须标记为“综合推断”。
3. 引文关系只能使用提供的关系数据，不得臆造。
4. 仅在输入明确提供页码时使用逐页引文，不得猜测页码。
5. 默认使用简洁中文，保留英文术语、方法名和公式。`;

const LIBRARY_REVIEW_BATCH_SIZE = 16;
const KNOWLEDGE_REPAIR_CITATION_BATCH_SIZE = 24;
const MAX_AI_FILE_INPUT_BYTES = 50 * 1024 * 1024;
const AI_FILE_COMPLETION_TIMEOUT_MS = 20 * 60_000;
const TRANSIENT_PROVIDER_RETRY_COUNT = 1;
const TRANSIENT_PROVIDER_RETRY_DELAY_MS = 300;
const CITATION_REFERENCE_HINT_BATCH_SIZE = 24;
const CITATION_REFERENCE_HINT_SYSTEM_PROMPT = `你是学术论文参考文献检索线索提取器。
输入只包含已经无法通过 OpenAlex 和 Crossref 常规匹配的原始书目。
规则：
1. 只从每条 rawCitation 中提取可用于再次检索的 title、authors、year、doi，不要直接判断匹配结果。
2. 不得使用常识补写原文没有支持的信息，不得猜测 DOI；字段不确定时省略。
3. id 必须原样返回，不得新增、删除、合并或调换引用。
4. 只输出严格 JSON，不要使用 Markdown 代码围栏或其它说明：
{"hints":[{"id":"REF_xxx","title":"Article title","authors":["Author"],"year":1948,"doi":"10.xxxx/xxxx"}]}`;

type CitationPatchChanges = Partial<
  Pick<
    CitationGraphNode,
    | "title"
    | "authors"
    | "journal"
    | "year"
    | "doi"
    | "volume"
    | "issue"
    | "pages"
  >
>;

export interface KnowledgePaperCitationPatch {
  id: string;
  confidence: number;
  changes: CitationPatchChanges;
}

export interface KnowledgePaperRepairResult {
  markdown: string;
  pageCount: number;
  textProtocol?: Exclude<ProviderProtocol, "auto">;
  textWarnings: string[];
  citationPatches: KnowledgePaperCitationPatch[];
  reviewedCitationNodeCount: number;
  protocol?: Exclude<ProviderProtocol, "auto">;
  model: string;
  warnings: string[];
}

interface KnowledgePaperRepairInput {
  paper: Paper;
  pdfPath: string;
  markdownPath: string;
  pages: DocumentPageText[];
  citationNodes: CitationGraphNode[];
  citationEdges: CitationGraphEdge[];
}

type KnowledgeRepairStage = (
  phase: "repairing-text" | "repairing-citations",
  detail: string,
) => void;

export async function askPaper(
  credentials: ProviderCredentials,
  input: AskPaperInput,
  options: ProviderRequestOptions = {},
): Promise<AskPaperResult> {
  const startedAt = Date.now();
  throwIfAborted(options.signal);
  const selectedSnippets = (
    input.selectedSnippets?.length
      ? input.selectedSnippets
      : input.selectedText?.trim() && input.selectedPage
        ? [{ text: input.selectedText, page: input.selectedPage }]
        : []
  )
    .map((snippet) => ({
      page: snippet.page,
      text: snippet.text.trim(),
      imageDataUrl: snippet.imageDataUrl,
      imageOnly: snippet.imageOnly,
    }))
    .filter((snippet) => snippet.text || snippet.imageDataUrl);
  const textSnippets = selectedSnippets.filter(
    (snippet) => !snippet.imageOnly && snippet.text,
  );
  const citationSources = textSnippets.map((snippet, index) => ({
    chunk_id: `${input.paperId}:selection:${index + 1}:p${snippet.page}`,
    page: snippet.page,
    text: snippet.text.slice(0, 8_000),
  }));
  const recent = input.messages.slice(-12).map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const selectedTextContext = textSnippets
    .map(
      (snippet) =>
        `[用户选中的 PDF 第 ${snippet.page} 页内容]\n${snippet.text.slice(0, 8_000)}`,
    )
    .join("\n\n");
  const imageSelectionContext = selectedSnippets
    .filter((snippet) => snippet.imageDataUrl)
    .map(
      (snippet) =>
        `用户还选择了 PDF 第 ${snippet.page} 页的图片区域，请结合图片回答。`,
    )
    .join("\n");
  const userPrompt = [
    input.question.trim(),
    selectedTextContext
      ? `用户明确选择了以下原文作为本轮补充上下文：\n\n${selectedTextContext}`
      : "",
    imageSelectionContext,
  ]
    .filter(Boolean)
    .join("\n\n");
  options.onProgress?.({
    phase: "thinking",
    detail: "正在提交当前论文 PDF 与问题",
  });
  const { content, reasoningContent, protocol } = await completeWithProvider(
    credentials,
    PAPER_ASSISTANT_SYSTEM_PROMPT,
    recent,
    userPrompt,
    input.reasoningEffort,
    options.signal,
    selectedSnippets,
    options.attachments,
    options.onProgress,
  );

  const message: ChatMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    content,
    reasoningContent,
    processingDurationMs: Date.now() - startedAt,
    citations: extractCitations(content, citationSources),
    createdAt: new Date().toISOString(),
  };
  return { message, protocol, model: credentials.model };
}

export async function listProviderModels(
  input: ProviderProfileInput,
): Promise<ProviderModel[]> {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) throw new Error("请先填写或保存 API Key。");
  const client = new OpenAI({
    apiKey,
    baseURL: normalizeBaseUrl(input.baseUrl),
    timeout: 30_000,
    maxRetries: 0,
  });
  const page = await client.models.list();
  const models = new Map<string, ProviderModel>();
  for (const model of page.data) {
    const id = model.id.trim();
    if (id) models.set(id, { id, ownedBy: model.owned_by });
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function generatePaperNote(
  credentials: ProviderCredentials,
  input: { paper: Paper; pdfPath: string; markdownPath?: string },
): Promise<Omit<GeneratePaperNoteResult, "note"> & { content: string }> {
  const pdfAttachment = await resolveProviderFileAttachment(input.pdfPath, {
    paperId: input.paper.id,
    fileName: input.paper.fileName || `${input.paper.title}.pdf`,
    mimeType: "application/pdf",
    kind: "pdf",
    pageCount: input.paper.pageCount,
    textFallbackPath: input.markdownPath,
  });
  try {
    const result = await completeWithProvider(
      credentials,
      NOTE_SYSTEM_PROMPT,
      [],
      `论文标题：${input.paper.title}\n\n请完整阅读随消息提供的 PDF，并生成结构化阅读笔记。`,
      undefined,
      undefined,
      [],
      [pdfAttachment],
    );
    const usedMarkdownFallback =
      result.attachmentInput === "text-fallback";
    return {
      ...result,
      model: credentials.model,
      source: usedMarkdownFallback ? "full.md" : "pdf",
      warning: usedMarkdownFallback
        ? "当前服务商使用 Chat Completions，已自动改用 full.md 文本生成笔记。"
        : undefined,
    };
  } catch (error) {
    if (!input.markdownPath || !isProviderContextTooLargeError(error)) {
      throw error;
    }
    const markdownAttachment = await resolveProviderFileAttachment(
      input.markdownPath,
      {
        paperId: input.paper.id,
        fileName: "full.md",
        mimeType: "text/markdown",
        kind: "text",
        pageCount: input.paper.pageCount,
      },
    );
    const result = await completeWithProvider(
      credentials,
      NOTE_SYSTEM_PROMPT,
      [],
      `论文标题：${input.paper.title}

当前服务商无法接收完整 PDF。请完整阅读附件中的 full.md，并根据其中的页面标记生成结构化阅读笔记。`,
      undefined,
      undefined,
      [],
      [markdownAttachment],
    );
    return {
      ...result,
      model: credentials.model,
      source: "full.md",
      warning:
        "完整 PDF 超过当前服务商的处理范围，已自动改用 full.md 生成笔记。",
    };
  }
}

export async function repairKnowledgePaperExport(
  credentials: ProviderCredentials,
  input: KnowledgePaperRepairInput,
  onStage?: KnowledgeRepairStage,
  options: KnowledgeRepairRequestOptions = {},
): Promise<KnowledgePaperRepairResult> {
  const { signal } = options;
  const warnings: string[] = [];
  const textWarnings: string[] = [];
  let protocol: Exclude<ProviderProtocol, "auto"> | undefined;
  let textProtocol: Exclude<ProviderProtocol, "auto"> | undefined;
  let markdown = normalizeModelMarkdown(options.cachedMarkdown ?? "");

  if (!markdown) {
    throwIfAborted(signal);
    const sourceMarkdown = normalizeModelMarkdown(
      await readFile(input.markdownPath, "utf8"),
    );
    if (!sourceMarkdown) {
      throw new Error("论文全文文件为空，无法交给 AI 修复。");
    }
    const pdfAttachment = await resolveProviderFileAttachment(input.pdfPath, {
      paperId: input.paper.id,
      fileName: input.paper.fileName || `${input.paper.title}.pdf`,
      mimeType: "application/pdf",
      kind: "pdf",
      pageCount: input.pages.length,
      textFallbackPath: input.markdownPath,
    });
    onStage?.(
      "repairing-text",
      credentials.protocol === "chat-completions"
        ? `正在将 full.md 全文一次性发送给 ${credentials.model} 转换与修复`
        : `正在将原始 PDF 一次性发送给 ${credentials.model} 转换与修复`,
    );
    const reportProgress = createKnowledgeRepairProgressReporter(
      credentials.model,
      onStage,
    );
    let result: Awaited<ReturnType<typeof completeWithProvider>>;
    try {
      result = await completeWithProvider(
        credentials,
        KNOWLEDGE_MARKDOWN_REPAIR_SYSTEM_PROMPT,
        [],
        `论文标题：${input.paper.title}

请完整读取随消息提供的原始 PDF 或全文文本，将整篇论文转换并修复为 Markdown。必须返回全部页面和完整正文。`,
        undefined,
        signal,
        [],
        [pdfAttachment],
        reportProgress,
      );
    } catch (error) {
      throwIfAborted(signal);
      if (
        !isProviderFileInputUnsupportedError(error) &&
        !isProviderContextTooLargeError(error)
      ) {
        throw error;
      }
      onStage?.(
        "repairing-text",
        "当前接口无法直接处理原始 PDF，改用 full.md 全文进行一次兼容修复",
      );
      result = await completeWithProvider(
        credentials,
        KNOWLEDGE_MARKDOWN_REPAIR_SYSTEM_PROMPT,
        [],
        `论文标题：${input.paper.title}

当前服务商无法接收原始 PDF。以下是 PaperXcel 本地提取的完整 full.md，请修复并返回整篇 Markdown，不得摘要、删节或只返回修改片段。

----- BEGIN FULL.MD -----
${sourceMarkdown}
----- END FULL.MD -----`,
        undefined,
        signal,
        [],
        [],
        reportProgress,
        { timeoutMs: AI_FILE_COMPLETION_TIMEOUT_MS },
      );
      textWarnings.push(
        "当前服务商未能处理原始 PDF，已自动改用 full.md 全文完成单次修复。",
      );
    }
    if (result.attachmentInput === "text-fallback") {
      textWarnings.push(
        "当前请求通过 Chat Completions 完成，已按兼容模式使用 full.md 全文作为纯文本上下文。",
      );
    }
    protocol = result.protocol;
    textProtocol = result.protocol;
    markdown = normalizeModelMarkdown(result.content);
    validateRepairedPaperMarkdown(markdown, sourceMarkdown);
  }

  const citationPatches: KnowledgePaperCitationPatch[] = [];
  const citationEvidence = buildCitationRepairEvidence(input.pages);
  const citationBatches = chunkValues(
    input.citationNodes.filter((node) => node.kind === "external"),
    KNOWLEDGE_REPAIR_CITATION_BATCH_SIZE,
  );
  for (const [index, nodes] of citationBatches.entries()) {
    throwIfAborted(signal);
    onStage?.(
      "repairing-citations",
      `校对引文 ${index + 1}/${citationBatches.length}`,
    );
    try {
      const nodeIds = new Set(nodes.map((node) => node.id));
      const result = await completeWithProvider(
        credentials,
        KNOWLEDGE_CITATION_REPAIR_SYSTEM_PROMPT,
        [],
        `当前论文：${input.paper.title}

当前论文的引用边：
${JSON.stringify(
  input.citationEdges.filter(
    (edge) => nodeIds.has(edge.source) || nodeIds.has(edge.target),
  ),
)}

待校对的外部节点：
${JSON.stringify(
  nodes.map((node) => ({
    id: node.id,
    title: node.title,
    authors: node.authors,
    journal: node.journal,
    year: node.year,
    doi: node.doi,
    volume: node.volume,
    issue: node.issue,
    pages: node.pages,
    raw_citation: node.rawCitation,
  })),
)}

论文中的参考文献证据：
${citationEvidence || "未提取到可靠的参考文献页面文本。"}

只返回有明确修正依据的节点。`,
        undefined,
        signal,
      );
      protocol = result.protocol;
      citationPatches.push(
        ...parseKnowledgeCitationRepair(result.content, nodeIds),
      );
    } catch (error) {
      throwIfAborted(signal);
      warnings.push(
        `第 ${index + 1}/${citationBatches.length} 组引文未完成 AI 校对：${providerErrorMessage(error)}`,
      );
    }
  }

  throwIfAborted(signal);
  return {
    markdown,
    pageCount: input.pages.length,
    textProtocol,
    textWarnings,
    citationPatches,
    reviewedCitationNodeCount: input.citationNodes.length,
    protocol,
    model: credentials.model,
    warnings,
  };
}

export async function generateLibraryReview(
  credentials: ProviderCredentials,
  input: {
    focus: string;
    papers: Array<{
      label: string;
      title: string;
      authors: string[];
      year?: number;
      doi?: string;
      note: PaperNote;
    }>;
    citationContext: string;
  },
): Promise<Omit<LibraryReview, "id" | "paperIds" | "createdAt">> {
  if (!input.papers.length) {
    throw new Error("当前没有可用于生成综述的论文笔记。");
  }
  const focus = input.focus.trim().slice(0, 500);
  const paperContext = input.papers.map(formatReviewPaper);
  let synthesisContext: string;
  if (paperContext.length <= LIBRARY_REVIEW_BATCH_SIZE) {
    synthesisContext = paperContext.join("\n\n---\n\n");
  } else {
    const analyses: string[] = [];
    for (
      let offset = 0;
      offset < paperContext.length;
      offset += LIBRARY_REVIEW_BATCH_SIZE
    ) {
      const batch = paperContext.slice(
        offset,
        offset + LIBRARY_REVIEW_BATCH_SIZE,
      );
      const result = await completeWithProvider(
        credentials,
        LIBRARY_REVIEW_BATCH_SYSTEM_PROMPT,
        [],
        `研究焦点：${focus || "综合梳理当前文献库"}\n\n论文笔记：\n\n${batch.join(
          "\n\n---\n\n",
        )}\n\n请输出本组文献的主题综合，保留论文编号。`,
      );
      analyses.push(
        `### 分组 ${analyses.length + 1}\n\n${result.content.trim()}`,
      );
    }
    synthesisContext = analyses.join("\n\n---\n\n");
  }

  const result = await completeWithProvider(
    credentials,
    LIBRARY_REVIEW_SYSTEM_PROMPT,
    [],
    `研究焦点：${focus || "综合梳理当前文献库"}

纳入论文：${input.papers.length} 篇

论文全文或分组综合：

${synthesisContext}

引文关系：

${input.citationContext || "当前没有已确认的库内引文关系。"}

请生成全库文献综述。`,
  );
  return {
    focus,
    content: result.content,
    protocol: result.protocol,
    model: credentials.model,
  };
}

export async function answerLibraryQuestion(
  credentials: ProviderCredentials,
  input: {
    question: string;
    reasoningEffort?: ModelReasoningEffort;
    papers: Array<{ id: string; label: string; title: string }>;
    sources: LibraryCitationSource[];
    history?: LibraryAskHistoryMessage[];
    sourceMode?: "selected" | "retrieved";
  },
): Promise<LibraryAskResult> {
  const question = input.question.trim();
  if (!question) throw new Error("请输入全库研究问题。");
  if (!input.sources.length) {
    throw new Error("当前文献库没有检索到足以回答该问题的证据。");
  }

  const context = input.papers
    .map((paper) => {
      const evidence = input.sources
        .filter((source) => source.paperId === paper.id)
        .map(
          (source) =>
            `[${paper.label} | PAGE ${source.page} | CHUNK ${source.chunk_id}]\n${source.text.trim()}`,
        )
        .join("\n\n");
      return `${paper.label} 标题：${paper.title}\n\n${evidence}`;
    })
    .join("\n\n==========\n\n");
  const evidencePrompt = `本轮${
    input.sourceMode === "selected"
      ? "用户明确选中的"
      : "系统根据问题自动检索到的"
  }索引片段（${input.sources.length} 条）如下：\n\n${context}`;
  const result = await completeWithProvider(
    credentials,
    LIBRARY_QA_SYSTEM_PROMPT,
    input.history ?? [],
    [
      `本轮研究问题：${question}`,
      evidencePrompt,
      "请结合历史对话理解追问。索引引用只可来自本轮提供的索引片段。",
    ]
      .filter(Boolean)
      .join("\n\n"),
    input.reasoningEffort,
  );
  return {
    content: result.content,
    citations: extractLibraryCitations(result.content, input.sources),
    protocol: result.protocol,
    model: credentials.model,
  };
}

export async function extractCitationReferenceSearchHints(
  credentials: ProviderCredentials,
  references: CitationReferenceSearchRequest[],
): Promise<CitationReferenceSearchHint[]> {
  const normalized = references
    .map((reference) => ({
      id: reference.id.trim(),
      rawCitation: reference.rawCitation.trim(),
    }))
    .filter((reference) => reference.id && reference.rawCitation);
  if (!normalized.length) return [];

  const hints: CitationReferenceSearchHint[] = [];
  for (const batch of chunkValues(
    normalized,
    CITATION_REFERENCE_HINT_BATCH_SIZE,
  )) {
    const result = await completeWithProvider(
      credentials,
      CITATION_REFERENCE_HINT_SYSTEM_PROMPT,
      [],
      JSON.stringify({ references: batch }),
    );
    hints.push(
      ...parseCitationReferenceSearchHints(
        result.content,
        new Set(batch.map((reference) => reference.id)),
      ),
    );
  }
  return hints;
}

export async function testProvider(
  input: ProviderProfileInput,
): Promise<{ ok: boolean; detail: string }> {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) {
    return { ok: false, detail: "请输入 API Key 后再测试。" };
  }
  const model = input.model.trim();
  if (!model) {
    return { ok: false, detail: "请先填写模型 ID。" };
  }
  try {
    const client = new OpenAI({
      apiKey,
      baseURL: normalizeBaseUrl(input.baseUrl),
      timeout: 30_000,
      maxRetries: 0,
    });
    const { protocol, fellBack } = await runWithResolvedProtocol(
      input.protocol,
      () => probeWithResponses(client, model),
      () => probeWithChatCompletions(client, model),
    );
    const protocolLabel =
      protocol === "responses" ? "Responses API" : "Chat Completions";
    return {
      ok: true,
      detail: fellBack
        ? `连接成功，模型 ${model} 可用（${protocolLabel}；已从 Responses 自动回退）。`
        : `连接成功，模型 ${model} 可用（${protocolLabel}）。`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: redactError(
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}

async function completeWithProvider(
  credentials: ProviderCredentials,
  instructions: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  userPrompt: string,
  reasoningEffort?: ModelReasoningEffort,
  signal?: AbortSignal,
  selectedSnippets: Array<{ imageDataUrl?: string }> = [],
  attachments: ResolvedChatAttachment[] = [],
  onProgress?: (progress: Omit<ChatProgress, "requestId">) => void,
  requestOptions: ProviderCompletionRequestOptions = {},
): Promise<{
  content: string;
  reasoningContent?: string;
  attachmentInput?: "text-fallback";
  protocol: Exclude<ProviderProtocol, "auto">;
}> {
  const effectiveProgress =
    onProgress ?? (attachments.length ? ignoreProviderProgress : undefined);
  const client = new OpenAI({
    apiKey: credentials.apiKey,
    baseURL: credentials.baseUrl,
    timeout:
      requestOptions.timeoutMs ??
      (attachments.length ? AI_FILE_COMPLETION_TIMEOUT_MS : 120_000),
    maxRetries: 0,
  });
  try {
    const { protocol, value } = await runWithResolvedProtocol(
      credentials.protocol,
      () =>
        askWithResponses(
          client,
          credentials.model,
          instructions,
          history,
          userPrompt,
          reasoningEffort,
          signal,
          selectedSnippets,
          attachments,
          effectiveProgress,
        ),
      () =>
        askWithChatCompletions(
          client,
          credentials.model,
          instructions,
          history,
          userPrompt,
          reasoningEffort,
          signal,
          selectedSnippets,
          attachments,
          effectiveProgress,
        ),
      {
        signal,
        onRetry: (protocol, attempt) => {
          effectiveProgress?.({
            phase: "thinking",
            detail: `上游暂时不可用，正在重试 ${protocolLabel(protocol)}（${attempt}/${TRANSIENT_PROVIDER_RETRY_COUNT}）`,
          });
        },
        onFallback: () => {
          effectiveProgress?.({
            phase: "thinking",
            detail: "Responses 暂时不可用，正在切换 Chat Completions",
          });
        },
      },
    );
    return { protocol, ...value };
  } catch (error) {
    throw providerRequestError(error, credentials.protocol);
  }
}

async function runWithResolvedProtocol<T>(
  protocol: ProviderProtocol,
  runResponses: () => Promise<T>,
  runChatCompletions: () => Promise<T>,
  options: {
    signal?: AbortSignal;
    onRetry?: (
      protocol: Exclude<ProviderProtocol, "auto">,
      attempt: number,
    ) => void;
    onFallback?: () => void;
  } = {},
): Promise<{
  protocol: Exclude<ProviderProtocol, "auto">;
  value: T;
  fellBack: boolean;
}> {
  const runResponsesWithRetry = (): Promise<T> =>
    runWithTransientProviderRetry("responses", runResponses, options);
  const runChatCompletionsWithRetry = (): Promise<T> =>
    runWithTransientProviderRetry(
      "chat-completions",
      runChatCompletions,
      options,
    );
  if (protocol === "chat-completions") {
    return {
      protocol: "chat-completions",
      value: await runChatCompletionsWithRetry(),
      fellBack: false,
    };
  }
  if (protocol === "responses") {
    return {
      protocol: "responses",
      value: await runResponsesWithRetry(),
      fellBack: false,
    };
  }
  try {
    return {
      protocol: "responses",
      value: await runResponsesWithRetry(),
      fellBack: false,
    };
  } catch (error) {
    if (!shouldFallbackToChatCompletions(error)) {
      throw error;
    }
    options.onFallback?.();
    return {
      protocol: "chat-completions",
      value: await runChatCompletionsWithRetry(),
      fellBack: true,
    };
  }
}

async function runWithTransientProviderRetry<T>(
  protocol: Exclude<ProviderProtocol, "auto">,
  run: () => Promise<T>,
  options: {
    signal?: AbortSignal;
    onRetry?: (
      protocol: Exclude<ProviderProtocol, "auto">,
      attempt: number,
    ) => void;
  },
): Promise<T> {
  for (
    let attempt = 0;
    attempt <= TRANSIENT_PROVIDER_RETRY_COUNT;
    attempt += 1
  ) {
    throwIfAborted(options.signal);
    try {
      return await run();
    } catch (error) {
      throwIfAborted(options.signal);
      if (
        attempt >= TRANSIENT_PROVIDER_RETRY_COUNT ||
        !isTransientProviderError(error)
      ) {
        throw error;
      }
      options.onRetry?.(protocol, attempt + 1);
      await abortableDelay(
        TRANSIENT_PROVIDER_RETRY_DELAY_MS * (attempt + 1),
        options.signal,
      );
    }
  }
  throw new Error("Provider retry loop ended unexpectedly.");
}

async function probeWithResponses(
  client: OpenAI,
  model: string,
): Promise<void> {
  const response = await client.responses.create({
    model,
    input: "Reply with OK.",
    store: false,
  });
  requireResponsesText(response, "探测文本");
}

async function probeWithChatCompletions(
  client: OpenAI,
  model: string,
): Promise<void> {
  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: "Reply with OK." }],
  });
  if (!extractChatCompletionText(response)) {
    throw new Error("Chat Completions API 未返回可识别的探测文本。");
  }
}

async function askWithResponses(
  client: OpenAI,
  model: string,
  instructions: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  userPrompt: string,
  reasoningEffort: ModelReasoningEffort | undefined,
  signal?: AbortSignal,
  selectedSnippets: Array<{ imageDataUrl?: string }> = [],
  attachments: ResolvedChatAttachment[] = [],
  onProgress?: (progress: Omit<ChatProgress, "requestId">) => void,
): Promise<ProviderTextCompletion> {
  const paperContextAttachments = attachments.filter(
    isCurrentPaperContextAttachment,
  );
  const userAttachments = attachments.filter(
    (attachment) => !isCurrentPaperContextAttachment(attachment),
  );
  const paperAttachmentParts = await buildResponsesAttachmentParts(
    paperContextAttachments,
  );
  const userAttachmentParts =
    await buildResponsesAttachmentParts(userAttachments);
  const input = [
    ...(paperAttachmentParts.length
      ? [
          {
            role: "user" as const,
            content: [
              {
                type: "input_text" as const,
                text: "这是当前会话对应的论文 PDF。后续问题默认以此文件为主要上下文。",
              },
              ...paperAttachmentParts,
            ],
          },
        ]
      : []),
    ...history.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    {
      role: "user" as const,
      content: [
        ...selectedSnippets
          .map((snippet) => snippet.imageDataUrl)
          .filter((imageDataUrl): imageDataUrl is string =>
            Boolean(imageDataUrl),
          )
          .slice(0, 3)
          .map((imageDataUrl) => ({
            type: "input_image" as const,
            image_url: imageDataUrl,
            detail: "high" as const,
          })),
        ...userAttachmentParts,
        { type: "input_text" as const, text: userPrompt },
      ],
    },
  ];
  const reasoning = responsesReasoningConfig(
    normalizeReasoningEffort(reasoningEffort),
  );
  if (!onProgress) {
    const response = await client.responses.create(
      {
        model,
        instructions,
        input,
        reasoning,
        store: false,
      },
      { signal },
    );
    return normalizeProviderCompletion(
      requireResponsesText(response),
      extractResponsesReasoning(response),
    );
  }

  onProgress({
    phase: "thinking",
    detail: "等待模型响应",
  });
  const stream = await client.responses.create(
    {
      model,
      instructions,
      input,
      reasoning,
      store: false,
      stream: true,
    },
    { signal },
  );
  let content: string;
  let reasoningContent = "";
  const reasoningSummaryParts = new Map<string, string>();
  const reasoningTextParts = new Map<string, string>();
  const thinkMarkup = new ThinkMarkupStreamParser();
  let sawOutputTextDelta = false;
  let completedResponse: unknown;
  for await (const event of stream) {
    throwIfAborted(signal);
    const record = objectRecord(event);
    if (!record) continue;
    const type = normalizedText(record.type);
    if (type.startsWith("response.reasoning") && type.endsWith(".delta")) {
      const delta = streamText(record.delta);
      if (delta) {
        const parts = type.includes("summary")
          ? reasoningSummaryParts
          : reasoningTextParts;
        const key = responseReasoningPartKey(record, type);
        parts.set(key, (parts.get(key) ?? "") + delta);
        reasoningContent =
          joinReasoningParts(reasoningSummaryParts) ||
          joinReasoningParts(reasoningTextParts);
        onProgress({
          phase: "thinking",
          detail: "模型正在推理",
          reasoningContent,
          reasoningDelta: delta,
        });
      }
      continue;
    }
    if (type.startsWith("response.reasoning") && type.endsWith(".done")) {
      const text = streamText(record.text);
      if (text) {
        const parts = type.includes("summary")
          ? reasoningSummaryParts
          : reasoningTextParts;
        const key = responseReasoningPartKey(record, type);
        const previousReasoning = reasoningContent;
        parts.set(key, text);
        reasoningContent =
          joinReasoningParts(reasoningSummaryParts) ||
          joinReasoningParts(reasoningTextParts);
        if (reasoningContent === previousReasoning) continue;
        const delta = reasoningContent.startsWith(previousReasoning)
          ? reasoningContent.slice(previousReasoning.length)
          : text;
        onProgress({
          phase: "thinking",
          detail: "模型正在推理",
          reasoningContent,
          reasoningDelta: delta,
        });
      }
      continue;
    }
    if (type === "response.output_text.delta") {
      const delta = streamText(record.delta);
      if (delta) {
        sawOutputTextDelta = true;
        const parsed = thinkMarkup.push(delta);
        content = parsed.content;
        const combinedReasoning = combineReasoningContent(
          reasoningContent,
          parsed.reasoningContent,
        );
        if (parsed.reasoningDelta) {
          onProgress({
            phase: "thinking",
            detail: "模型正在推理",
            reasoningContent: combinedReasoning,
          });
        }
        if (parsed.contentDelta) {
          onProgress({
            phase: "answering",
            detail: "正在生成回答",
            reasoningContent: combinedReasoning || undefined,
            answerContent: content,
            answerDelta: parsed.contentDelta,
          });
        }
      }
      continue;
    }
    if (type === "response.output_text.done" && !sawOutputTextDelta) {
      const text = streamText(record.text);
      if (text) {
        const parsed = thinkMarkup.push(text);
        content = parsed.content;
        const combinedReasoning = combineReasoningContent(
          reasoningContent,
          parsed.reasoningContent,
        );
        if (parsed.reasoningDelta) {
          onProgress({
            phase: "thinking",
            detail: "模型正在推理",
            reasoningContent: combinedReasoning,
          });
        }
        if (parsed.contentDelta) {
          onProgress({
            phase: "answering",
            detail: "正在生成回答",
            reasoningContent: combinedReasoning || undefined,
            answerContent: content,
            answerDelta: parsed.contentDelta,
          });
        }
      }
      continue;
    }
    if (type === "response.failed" || type === "error") {
      const error = objectRecord(record.error);
      throw new Error(
        normalizedText(error?.message) || "Responses API 生成回答失败。",
      );
    }
    if (type === "response.incomplete") {
      throw new Error("模型提前停止，回答不完整。");
    }
    if (type === "response.completed") {
      completedResponse = record.response;
    }
  }
  const finalParsed = thinkMarkup.finish();
  content = finalParsed.content;
  reasoningContent = combineReasoningContent(
    reasoningContent,
    finalParsed.reasoningContent,
  );
  if (finalParsed.reasoningDelta) {
    onProgress({
      phase: "thinking",
      detail: "模型正在推理",
      reasoningContent,
    });
  }
  if (finalParsed.contentDelta) {
    onProgress({
      phase: "answering",
      detail: "正在生成回答",
      reasoningContent: reasoningContent || undefined,
      answerContent: content,
      answerDelta: finalParsed.contentDelta,
    });
  }
  if (!content && completedResponse) {
    content = extractResponsesText(completedResponse);
  }
  if (!reasoningContent && completedResponse) {
    reasoningContent = extractResponsesReasoning(completedResponse);
  }
  if (!content.trim()) {
    throw new Error("Responses API 未返回可识别的文本内容。");
  }
  return normalizeProviderCompletion(content, reasoningContent);
}

async function askWithChatCompletions(
  client: OpenAI,
  model: string,
  instructions: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  userPrompt: string,
  reasoningEffort: ModelReasoningEffort | undefined,
  signal?: AbortSignal,
  selectedSnippets: Array<{ imageDataUrl?: string }> = [],
  attachments: ResolvedChatAttachment[] = [],
  onProgress?: (progress: Omit<ChatProgress, "requestId">) => void,
): Promise<ProviderTextCompletion> {
  const paperContextAttachments = attachments.filter(
    isCurrentPaperContextAttachment,
  );
  const userAttachments = attachments.filter(
    (attachment) => !isCurrentPaperContextAttachment(attachment),
  );
  const paperAttachmentContent = await prepareChatAttachments(
    paperContextAttachments,
  );
  const userAttachmentContent = await prepareChatAttachments(userAttachments);
  const selectedImageParts = selectedSnippets
    .map((snippet) => snippet.imageDataUrl)
    .filter((imageDataUrl): imageDataUrl is string => Boolean(imageDataUrl))
    .slice(0, 3)
    .map((imageDataUrl) => ({
      type: "image_url" as const,
      image_url: { url: imageDataUrl, detail: "high" as const },
    }));
  const userText = [...userAttachmentContent.textBlocks, userPrompt]
    .filter(Boolean)
    .join("\n\n");
  const userParts = [
    ...selectedImageParts,
    ...userAttachmentContent.parts,
  ];
  const paperText = [
    "这是当前会话对应的论文内容。后续问题默认以此内容为主要上下文。",
    ...paperAttachmentContent.textBlocks,
  ].join("\n\n");
  const messages = [
    { role: "system" as const, content: instructions },
    ...(paperAttachmentContent.textBlocks.length ||
    paperAttachmentContent.parts.length
      ? [
          {
            role: "user" as const,
            content: paperAttachmentContent.parts.length
              ? [
                  { type: "text" as const, text: paperText },
                  ...paperAttachmentContent.parts,
                ]
              : paperText,
          },
        ]
      : []),
    ...history,
    {
      role: "user" as const,
      content: userParts.length
        ? [{ type: "text" as const, text: userText }, ...userParts]
        : userText,
    },
  ];
  const attachmentInput = attachments.some(
    (attachment) => attachment.attachment.kind !== "image",
  )
    ? ("text-fallback" as const)
    : undefined;
  const reasoningEffortValue = normalizeReasoningEffort(reasoningEffort);
  if (!onProgress) {
    const response = await client.chat.completions.create(
      {
        model,
        messages,
        reasoning_effort: reasoningEffortValue,
      },
      { signal },
    );
    const content = extractChatCompletionText(response);
    if (!content) throw new Error("模型未返回文本内容。");
    return {
      ...normalizeProviderCompletion(
        content,
        extractChatCompletionReasoning(response),
      ),
      attachmentInput,
    };
  }

  onProgress({
    phase: "thinking",
    detail: "等待模型响应",
  });
  const stream = await client.chat.completions.create(
    {
      model,
      messages,
      reasoning_effort: reasoningEffortValue,
      stream: true,
    },
    { signal },
  );
  let explicitReasoning = "";
  const thinkMarkup = new ThinkMarkupStreamParser();
  let finishReason: string | undefined;
  for await (const chunk of stream) {
    throwIfAborted(signal);
    const chunkRecord = objectRecord(chunk);
    const choices = Array.isArray(chunkRecord?.choices)
      ? chunkRecord.choices
      : [];
    const choice = objectRecord(choices[0]);
    finishReason = normalizedText(choice?.finish_reason) || finishReason;
    const delta = objectRecord(choice?.delta);
    if (!delta) continue;

    const reasoningDelta = extractReasoningDelta(delta);
    if (reasoningDelta) {
      explicitReasoning += reasoningDelta;
      onProgress({
        phase: "thinking",
        detail: "模型正在推理",
        reasoningContent: explicitReasoning,
        reasoningDelta,
      });
    }

    const contentDelta = streamText(delta.content) || streamText(delta.refusal);
    if (!contentDelta) continue;
    const parsed = thinkMarkup.push(contentDelta);
    const combinedReasoning = combineReasoningContent(
      explicitReasoning,
      parsed.reasoningContent,
    );
    if (parsed.reasoningDelta) {
      onProgress({
        phase: "thinking",
        detail: "模型正在推理",
        reasoningContent: combinedReasoning,
      });
    }
    if (parsed.contentDelta) {
      onProgress({
        phase: "answering",
        detail: "正在生成回答",
        reasoningContent: combinedReasoning || undefined,
        answerContent: parsed.content,
        answerDelta: parsed.contentDelta,
      });
    }
  }
  const parsed = thinkMarkup.finish();
  const combinedReasoning = combineReasoningContent(
    explicitReasoning,
    parsed.reasoningContent,
  );
  if (parsed.reasoningDelta) {
    onProgress({
      phase: "thinking",
      detail: "模型正在推理",
      reasoningContent: combinedReasoning,
    });
  }
  if (parsed.contentDelta) {
    onProgress({
      phase: "answering",
      detail: "正在生成回答",
      reasoningContent: combinedReasoning || undefined,
      answerContent: parsed.content,
      answerDelta: parsed.contentDelta,
    });
  }
  if (finishReason === "length") {
    throw new Error("模型回答超过输出长度限制，内容不完整。");
  }
  if (!parsed.content.trim()) {
    throw new Error("模型未返回文本内容。");
  }
  return {
    ...normalizeProviderCompletion(parsed.content, combinedReasoning),
    attachmentInput,
  };
}

interface ThinkMarkupStreamResult {
  content: string;
  reasoningContent: string;
  contentDelta: string;
  reasoningDelta: string;
}

class ThinkMarkupStreamParser {
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

type ResponsesAttachmentPart =
  | {
      type: "input_image";
      image_url: string;
      detail: "high";
    }
  | {
      type: "input_file";
      filename: string;
      file_data: string;
    };

type ChatAttachmentPart = {
  type: "image_url";
  image_url: { url: string; detail: "high" };
};

interface PreparedChatAttachments {
  parts: ChatAttachmentPart[];
  textBlocks: string[];
}

async function buildResponsesAttachmentParts(
  attachments: ResolvedChatAttachment[],
): Promise<ResponsesAttachmentPart[]> {
  return Promise.all(
    attachments.map(async (resolved) => {
      const dataUrl = await readChatAttachmentDataUrl(resolved);
      if (resolved.attachment.kind === "image") {
        return {
          type: "input_image" as const,
          image_url: dataUrl,
          detail: "high" as const,
        };
      }
      return {
        type: "input_file" as const,
        filename: resolved.attachment.fileName,
        file_data: dataUrl,
      };
    }),
  );
}

async function prepareChatAttachments(
  attachments: ResolvedChatAttachment[],
): Promise<PreparedChatAttachments> {
  const prepared = await Promise.all(
    attachments.map(async (resolved) => {
      if (resolved.attachment.kind === "image") {
        return {
          part: {
            type: "image_url" as const,
            image_url: {
              url: await readChatAttachmentDataUrl(resolved),
              detail: "high" as const,
            },
          },
        };
      }

      const text = await readChatAttachmentText(resolved);
      return {
        textBlock: formatChatAttachmentText(resolved, text),
      };
    }),
  );
  return {
    parts: prepared.flatMap((item) => (item.part ? [item.part] : [])),
    textBlocks: prepared.flatMap((item) =>
      item.textBlock ? [item.textBlock] : [],
    ),
  };
}

async function readChatAttachmentText(
  resolved: ResolvedChatAttachment,
): Promise<string> {
  // OpenAI-compatible gateways often validate Chat Completions against the
  // older text/image schema. Files stay native on Responses; Chat receives
  // locally readable text so no provider-specific message wrapper is needed.
  const textPath =
    resolved.attachment.kind === "text"
      ? resolved.filePath
      : resolved.textFallbackPath;
  if (!textPath) {
    throw new Error(
      `Chat Completions 无法直接读取附件 ${resolved.attachment.fileName}。请使用 Responses API，或先将文件转换为 Markdown / 文本。`,
    );
  }
  const text = (await readFile(textPath, "utf8")).replace(/^\uFEFF/, "").trim();
  if (!text) {
    throw new Error(`附件 ${resolved.attachment.fileName} 没有可读取的文本。`);
  }
  return text;
}

function formatChatAttachmentText(
  resolved: ResolvedChatAttachment,
  text: string,
): string {
  const source =
    resolved.attachment.kind === "pdf" ? "PaperXcel 本地提取文本" : "文本附件";
  return [
    `----- BEGIN ATTACHMENT: ${resolved.attachment.fileName} -----`,
    `来源：${source}`,
    text,
    `----- END ATTACHMENT: ${resolved.attachment.fileName} -----`,
  ].join("\n");
}

function requireResponsesText(response: unknown, label = "文本内容"): string {
  const content = extractResponsesText(response);
  if (content) return content;

  const detail = describeResponsesPayload(response);
  throw new Error(
    `Responses API 未返回可识别的${label}${detail ? `（${detail}）` : ""}。`,
  );
}

function extractResponsesText(response: unknown): string {
  const record = objectRecord(response);
  if (!record) return "";

  const direct = normalizedText(record.output_text);
  if (direct) return direct;

  const outputParts: string[] = [];
  if (Array.isArray(record.output)) {
    for (const item of record.output) {
      const output = objectRecord(item);
      if (!output) continue;
      const type = normalizedText(output.type);
      if (type === "message" || !type) {
        outputParts.push(...extractContentParts(output.content));
      } else if (type === "output_text" || type === "text") {
        const text = normalizedText(output.text);
        if (text) outputParts.push(text);
      }
    }
  }
  const outputText = outputParts.join("\n").trim();
  if (outputText) return outputText;

  return extractChatCompletionText(record);
}

function extractResponsesReasoning(response: unknown): string {
  const record = objectRecord(response);
  if (!record || !Array.isArray(record.output)) return "";

  const summaries: string[] = [];
  const reasoningText: string[] = [];
  for (const item of record.output) {
    const output = objectRecord(item);
    if (!output || normalizedText(output.type) !== "reasoning") continue;
    summaries.push(...extractContentParts(output.summary));
    reasoningText.push(...extractContentParts(output.content));
  }
  return (summaries.length ? summaries : reasoningText).join("\n\n").trim();
}

function extractChatCompletionText(response: unknown): string {
  const record = objectRecord(response);
  if (!record || !Array.isArray(record.choices)) return "";

  for (const item of record.choices) {
    const choice = objectRecord(item);
    const message = objectRecord(choice?.message);
    if (!message) continue;

    const content = extractContentParts(message.content).join("\n").trim();
    if (content) return content;

    const refusal = normalizedText(message.refusal);
    if (refusal) return refusal;
  }
  return "";
}

function extractChatCompletionReasoning(response: unknown): string {
  const record = objectRecord(response);
  if (!record || !Array.isArray(record.choices)) return "";

  const parts: string[] = [];
  for (const item of record.choices) {
    const choice = objectRecord(item);
    const message = objectRecord(choice?.message);
    if (!message) continue;
    const reasoning = extractReasoningDelta(message);
    if (reasoning) parts.push(reasoning);
  }
  return parts.join("\n\n").trim();
}

function extractReasoningDelta(record: Record<string, unknown>): string {
  return (
    streamText(record.reasoning_content) ||
    streamText(record.reasoning) ||
    streamText(record.thinking) ||
    streamText(record.reasoning_details)
  );
}

function responsesReasoningConfig(effort: ModelReasoningEffort | undefined):
  | {
      effort: ModelReasoningEffort;
      summary?: "auto";
    }
  | undefined {
  if (!effort) return undefined;
  return effort === "none"
    ? { effort }
    : {
        effort,
        summary: "auto",
      };
}

function normalizeReasoningEffort(
  effort: ModelReasoningEffort | string | undefined,
): ModelReasoningEffort | undefined {
  if (
    effort === "none" ||
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh"
  ) {
    return effort;
  }
  if (effort === "minimal") return "low";
  if (effort === "max") return "xhigh";
  return undefined;
}

function isCurrentPaperContextAttachment(
  resolved: ResolvedChatAttachment,
): boolean {
  return (
    resolved.attachment.kind === "pdf" &&
    resolved.attachment.source === "library" &&
    Boolean(resolved.attachment.paperId)
  );
}

function responseReasoningPartKey(
  record: Record<string, unknown>,
  type: string,
): string {
  const outputIndex =
    typeof record.output_index === "number" ? record.output_index : 0;
  const partIndexValue = type.includes("summary")
    ? record.summary_index
    : record.content_index;
  const partIndex = typeof partIndexValue === "number" ? partIndexValue : 0;
  return `${outputIndex}:${partIndex}`;
}

function joinReasoningParts(parts: Map<string, string>): string {
  return [...parts.values()]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

function combineReasoningContent(...parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part, index, values) => part && values.indexOf(part) === index)
    .join("\n\n");
}

function normalizeProviderCompletion(
  content: string,
  explicitReasoning = "",
): ProviderTextCompletion {
  const parsed = splitThinkMarkup(content);
  const normalizedContent = parsed.content.trim();
  if (!normalizedContent) throw new Error("模型未返回文本内容。");
  return {
    content: normalizedContent,
    reasoningContent:
      combineReasoningContent(explicitReasoning, parsed.reasoningContent) ||
      undefined,
  };
}

function splitThinkMarkup(value: string): {
  content: string;
  reasoningContent: string;
} {
  const reasoningParts: string[] = [];
  let content = value.replace(
    /<think\b[^>]*>([\s\S]*?)<\/think>/gi,
    (_match, reasoning: string) => {
      const normalized = reasoning.trim();
      if (normalized) reasoningParts.push(normalized);
      return "";
    },
  );
  const openThink = /<think\b[^>]*>/i.exec(content);
  if (openThink?.index !== undefined) {
    const reasoning = content
      .slice(openThink.index + openThink[0].length)
      .replace(/<\/think>/gi, "")
      .trim();
    if (reasoning) reasoningParts.push(reasoning);
    content = content.slice(0, openThink.index);
  }
  return {
    content: content.replace(/<\/?think\b[^>]*>/gi, "").trim(),
    reasoningContent: reasoningParts.join("\n\n").trim(),
  };
}

function extractContentParts(content: unknown): string[] {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? [text] : [];
  }
  if (!Array.isArray(content)) {
    const item = objectRecord(content);
    const text = normalizedText(item?.text);
    return text ? [text] : [];
  }

  const parts: string[] = [];
  for (const value of content) {
    if (typeof value === "string") {
      const text = value.trim();
      if (text) parts.push(text);
      continue;
    }
    const item = objectRecord(value);
    if (!item) continue;
    const type = normalizedText(item.type);
    if (
      type &&
      !["text", "output_text", "summary_text", "reasoning_text"].includes(type)
    ) {
      continue;
    }
    const text = normalizedText(item.text);
    if (text) parts.push(text);
  }
  return parts;
}

function describeResponsesPayload(response: unknown): string {
  const record = objectRecord(response);
  if (!record) return "响应不是对象";

  const details: string[] = [];
  const object = normalizedText(record.object);
  const status = normalizedText(record.status);
  if (object) details.push(`object=${object}`);
  if (status) details.push(`status=${status}`);

  if (Array.isArray(record.output)) {
    const outputTypes = [
      ...new Set(
        record.output
          .map((item) => normalizedText(objectRecord(item)?.type))
          .filter(Boolean),
      ),
    ];
    details.push(
      outputTypes.length
        ? `output=${outputTypes.join(",")}`
        : `output=${record.output.length} 项`,
    );
  }

  const incomplete = objectRecord(record.incomplete_details);
  const incompleteReason = normalizedText(incomplete?.reason);
  if (incompleteReason) details.push(`incomplete=${incompleteReason}`);

  const error = objectRecord(record.error);
  const errorCode = normalizedText(error?.code);
  const errorMessage = normalizedText(error?.message);
  if (errorCode) details.push(`error=${errorCode}`);
  else if (errorMessage) details.push(`error=${errorMessage.slice(0, 120)}`);

  if (!details.length) {
    details.push(`keys=${Object.keys(record).slice(0, 8).join(",") || "none"}`);
  }
  return details.join("；");
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function streamText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    const record = objectRecord(value);
    return typeof record?.text === "string" ? record.text : "";
  }
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      const record = objectRecord(part);
      return typeof record?.text === "string" ? record.text : "";
    })
    .join("");
}

function redactError(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
}

function providerRequestError(
  error: unknown,
  protocol: ProviderProtocol,
): Error {
  if (!isTransientProviderError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const requestId = getProviderRequestId(error);
  const recovery =
    protocol === "auto"
      ? "已自动重试并尝试切换 Responses / Chat Completions"
      : "已自动重试当前接口";
  return new Error(
    `AI 上游服务暂时不可用，${recovery}，请稍后重试或切换服务商。${
      requestId ? ` 请求 ID：${requestId}` : ""
    }`,
    { cause: error },
  );
}

function ignoreProviderProgress(
  _progress: Omit<ChatProgress, "requestId">,
): void {}

function createKnowledgeRepairProgressReporter(
  model: string,
  onStage?: KnowledgeRepairStage,
): ((progress: Omit<ChatProgress, "requestId">) => void) | undefined {
  if (!onStage) return undefined;
  let lastDetail = "";
  let lastReportedCharacters = 0;
  let lastReportedAt = 0;
  return (progress) => {
    if (progress.phase === "answering") {
      const characters = progress.answerContent?.length ?? 0;
      const now = Date.now();
      if (
        characters > 0 &&
        (characters - lastReportedCharacters >= 1_500 ||
          now - lastReportedAt >= 1_000)
      ) {
        lastReportedCharacters = characters;
        lastReportedAt = now;
        onStage(
          "repairing-text",
          `正在接收 ${model} 返回的完整论文（${characters.toLocaleString()} 字符）`,
        );
      }
      return;
    }
    const detail =
      progress.phase === "thinking"
        ? `原始 PDF 已提交，${progress.detail}`
        : progress.detail;
    if (detail && detail !== lastDetail) {
      lastDetail = detail;
      onStage("repairing-text", detail);
    }
  };
}

function isProviderFileInputUnsupportedError(error: unknown): boolean {
  const record = objectRecord(error);
  const nested = objectRecord(record?.error);
  const status = Number(record?.status);
  const text = [
    error instanceof Error ? error.message : "",
    record?.message,
    record?.code,
    record?.type,
    nested?.message,
    nested?.code,
    nested?.type,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return (
    (status === 400 || status === 422 || !Number.isFinite(status)) &&
    /(?:invalid|unsupported|not supported|supported values|validation|string_type|不支持|无效)/i.test(
      text,
    ) &&
    /(?:\bfile\b|file_data|input_file|GPT3Message|MMGPT3Item|文件)/i.test(text)
  );
}

function isProviderContextTooLargeError(error: unknown): boolean {
  const record = objectRecord(error);
  const nested = objectRecord(record?.error);
  const status = Number(record?.status);
  if (status === 413) return true;
  const text = [
    error instanceof Error ? error.message : "",
    record?.code,
    record?.type,
    nested?.message,
    nested?.code,
    nested?.type,
    nested?.reason,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return (
    /context[_ -]?too[_ -]?large/i.test(text) ||
    /request (?:content|body|payload).{0,20}too large/i.test(text) ||
    /请求内容过大|上下文.{0,20}超过.{0,20}范围|附件.{0,20}过大/.test(text)
  );
}

function protocolLabel(protocol: Exclude<ProviderProtocol, "auto">): string {
  return protocol === "responses" ? "Responses" : "Chat Completions";
}

async function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const complete = (): void => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(complete, milliseconds);
    const abort = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("Request aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    timeout.unref?.();
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("Request aborted", "AbortError");
}

function parseKnowledgeCitationRepair(
  value: string,
  allowedIds: Set<string>,
): KnowledgePaperCitationPatch[] {
  const parsed = parseModelJson(value);
  const record =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const corrections = Array.isArray(record.corrections)
    ? record.corrections
    : [];
  const patches: KnowledgePaperCitationPatch[] = [];
  for (const item of corrections) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const correction = item as Record<string, unknown>;
    const id = typeof correction.id === "string" ? correction.id.trim() : "";
    if (!allowedIds.has(id)) continue;
    const rawConfidence = Number(correction.confidence);
    const confidence =
      rawConfidence > 1 && rawConfidence <= 100
        ? rawConfidence / 100
        : rawConfidence;
    if (!Number.isFinite(confidence) || confidence < 0.75 || confidence > 1) {
      continue;
    }

    const changes: CitationPatchChanges = {};
    const title = optionalModelText(correction.title, 500);
    const journal = optionalModelText(correction.journal, 300);
    const volume = optionalModelText(correction.volume, 80);
    const issue = optionalModelText(correction.issue, 80);
    const pages = optionalModelText(correction.pages, 120);
    if (title) changes.title = title;
    if (journal) changes.journal = journal;
    if (volume) changes.volume = volume;
    if (issue) changes.issue = issue;
    if (pages) changes.pages = pages;

    if (Array.isArray(correction.authors)) {
      const authors = [
        ...new Set(
          correction.authors
            .filter((author): author is string => typeof author === "string")
            .map((author) => normalizeModelText(author).slice(0, 180))
            .filter(Boolean),
        ),
      ].slice(0, 40);
      if (authors.length) changes.authors = authors;
    }

    const year = Number(correction.year);
    const maxYear = new Date().getFullYear() + 1;
    if (Number.isInteger(year) && year >= 1400 && year <= maxYear) {
      changes.year = year;
    }

    if (typeof correction.doi === "string") {
      const doi = normalizeCitationDoi(correction.doi);
      if (doi && /^10\.\d{4,9}\/\S+$/i.test(doi)) changes.doi = doi;
    }

    if (Object.keys(changes).length) {
      patches.push({ id, confidence, changes });
    }
  }
  return patches;
}

function parseCitationReferenceSearchHints(
  value: string,
  allowedIds: Set<string>,
): CitationReferenceSearchHint[] {
  const parsed = parseModelJson(value);
  const record =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const rawHints = Array.isArray(record.hints) ? record.hints : [];
  const hints = new Map<string, CitationReferenceSearchHint>();
  for (const item of rawHints) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const hint = item as Record<string, unknown>;
    const id = typeof hint.id === "string" ? hint.id.trim() : "";
    if (!allowedIds.has(id)) continue;

    const title = optionalModelText(hint.title, 500);
    const authors = Array.isArray(hint.authors)
      ? [
          ...new Set(
            hint.authors
              .filter((author): author is string => typeof author === "string")
              .map((author) => normalizeModelText(author).slice(0, 180))
              .filter(Boolean),
          ),
        ].slice(0, 20)
      : [];
    const rawYear = Number(hint.year);
    const year =
      Number.isInteger(rawYear) &&
      rawYear >= 1400 &&
      rawYear <= new Date().getFullYear() + 1
        ? rawYear
        : undefined;
    const doi =
      typeof hint.doi === "string" ? normalizeCitationDoi(hint.doi) : undefined;
    if (!title && !doi) continue;

    hints.set(id, {
      id,
      title,
      authors: authors.length ? authors : undefined,
      year,
      doi,
    });
  }
  return [...hints.values()];
}

function buildCitationRepairEvidence(pages: DocumentPageText[]): string {
  if (!pages.length) return "";
  const headingIndex = pages.findIndex((page) =>
    /(?:^|\n)\s*(references|bibliography|参考文献|引用文献)\s*(?:\n|$)/im.test(
      page.text,
    ),
  );
  const candidates =
    headingIndex >= 0
      ? pages.slice(headingIndex)
      : pages.slice(Math.max(0, pages.length - 12));
  const blocks: string[] = [];
  let totalLength = 0;
  for (const page of candidates) {
    const block = `[PAGE ${page.page}]\n${page.text.trim()}`;
    if (blocks.length && totalLength + block.length > 48_000) break;
    blocks.push(block);
    totalLength += block.length;
  }
  return blocks.join("\n\n");
}

function parseModelJson(value: string): unknown {
  const source = value.trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || extractJsonContainer(source);
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error("模型返回的修复结果不是有效 JSON。");
  }
}

function extractJsonContainer(value: string): string {
  const objectStart = value.indexOf("{");
  const objectEnd = value.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    return value.slice(objectStart, objectEnd + 1);
  }
  const arrayStart = value.indexOf("[");
  const arrayEnd = value.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return value.slice(arrayStart, arrayEnd + 1);
  }
  throw new Error("模型没有返回 JSON 修复结果。");
}

function normalizeModelText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function normalizeModelMarkdown(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  const fenced = normalized.match(
    /^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```[ \t]*$/i,
  );
  return (fenced?.[1] ?? normalized).trim();
}

function validateRepairedPaperMarkdown(
  markdown: string,
  sourceMarkdown: string,
): void {
  const sourceLength = sourceMarkdown.length;
  if (
    sourceLength >= 4_000 &&
    markdown.length < Math.floor(sourceLength * 0.35)
  ) {
    throw new Error(
      "AI 返回的修复结果明显短于原始论文全文文件，模型可能只返回了摘要或截断内容。",
    );
  }
  if (sourceLength >= 200 && markdown.length < 200) {
    throw new Error("AI 返回的 Markdown 过短，未得到可用的完整修复结果。");
  }
}

async function resolveProviderFileAttachment(
  filePath: string,
  options: {
    paperId: string;
    fileName: string;
    mimeType: string;
    kind: "pdf" | "text";
    pageCount?: number;
    textFallbackPath?: string;
  },
): Promise<ResolvedChatAttachment> {
  const sourceInfo = await stat(filePath);
  if (!sourceInfo.isFile() || sourceInfo.size <= 0) {
    throw new Error(`${options.fileName} 不是有效的文件。`);
  }
  if (sourceInfo.size > MAX_AI_FILE_INPUT_BYTES) {
    throw new Error(`${options.fileName} 超过 AI 文件输入的 50 MB 限制。`);
  }
  return {
    attachment: {
      id: crypto.randomUUID(),
      fileName: options.fileName || basename(filePath),
      mimeType: options.mimeType,
      size: sourceInfo.size,
      kind: options.kind,
      source: "library",
      paperId: options.paperId,
      pageCount: options.pageCount,
    },
    filePath,
    textFallbackPath: options.textFallbackPath,
  };
}

function optionalModelText(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeModelText(value).slice(0, maxLength);
  return normalized || undefined;
}

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function providerErrorMessage(error: unknown): string {
  return redactError(error instanceof Error ? error.message : String(error));
}

function formatReviewPaper(
  paper: Parameters<typeof generateLibraryReview>[1]["papers"][number],
): string {
  const metadata = [
    paper.authors.length ? paper.authors.slice(0, 6).join(", ") : "",
    paper.year,
    paper.doi,
  ].filter(Boolean);
  return [
    `### ${paper.label} ${paper.title}`,
    metadata.length ? `元数据：${metadata.join(" · ")}` : "",
    "阅读笔记：",
    paper.note.content.trim().slice(0, 12_000),
  ]
    .filter(Boolean)
    .join("\n");
}
