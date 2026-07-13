import OpenAI from "openai";
import type {
  AskPaperInput,
  AskPaperResult,
  ChatMessage,
  ComparisonReport,
  GeneratePaperNoteResult,
  ModelReasoningEffort,
  ProviderModel,
  ProviderProfileInput,
  ProviderProtocol,
} from "../shared/contracts";
import { extractCitations } from "../shared/citations";
import {
  extractComparisonCitations,
  type ComparisonSource,
} from "../shared/comparisons";
import { shouldFallbackToChatCompletions } from "../shared/providerCompat";
import { normalizeBaseUrl } from "./store";
import type { WorkerClient } from "./worker-client";

interface ProviderCredentials {
  name: string;
  baseUrl: string;
  model: string;
  protocol: ProviderProtocol;
  apiKey: string;
}

interface SearchHit {
  chunk_id: string;
  page: number;
  text: string;
  score: number;
}

interface ProviderRequestOptions {
  signal?: AbortSignal;
}

const SYSTEM_PROMPT = `你是 PaperXcel 的量子力学与理论化学文献助手。
规则：
1. 只把提供的论文片段视为论文证据；明确区分“论文原文结论”和“你的推断”。
2. 每个关键事实都在句末使用【p.页码】引用。不得编造页码、公式编号、计算参数或结论。
3. 优先识别 Hamiltonian、近似、电子结构方法、交换关联泛函、基组、赝势、相对论处理、电子相关、收敛标准、软件和可观测量。
4. 解释公式时保留原符号，依次说明符号含义、物理意义、成立条件和与上下文的关系。
5. 证据不足时直接说明“当前检索片段不足以回答”，并指出需要查看的章节。
6. 默认使用简洁中文，保留英文术语、专有名词和数学表达式。`;

const NOTE_SYSTEM_PROMPT = `你是 PaperXcel 的量子力学与理论化学研究笔记助手。
根据提供的论文证据生成可继续编辑的 Markdown 阅读笔记。
规则：
1. 严格使用以下二级标题：研究问题、理论框架与 Hamiltonian、方法与关键近似、计算设置与复现参数、主要结果、局限性、待核查问题。
2. 每个可验证事实在句末使用【p.页码】引用，不得编造页码、公式编号、参数或结论。
3. 重点保留 Hamiltonian、wavefunction/functional、basis set、pseudopotential、relativistic treatment、electron correlation、convergence criteria、software 和 observable 的英文术语与原公式。
4. 对证据未覆盖的栏目写“当前检索证据未确认”，不要用常识补齐。
5. 明确区分论文结论、作者假设和你的推断；推断必须标为“推断”。
6. 使用简洁中文，不要输出代码围栏，也不要重复论文标题。`;

const NOTE_SEARCH_QUERIES = [
  "research question objective main conclusion key result abstract conclusion",
  "Hamiltonian theoretical method approximation wavefunction functional basis set electron correlation",
  "computational details software convergence threshold pseudopotential relativistic geometry reproducibility",
  "limitation uncertainty error assumption future work applicability",
];

const COMPARISON_SYSTEM_PROMPT = `你是 PaperXcel 的量子力学与理论化学跨文献分析助手。
根据多篇论文的检索证据生成可审计的 Markdown 研究矩阵。
规则：
1. 严格使用以下二级标题：对比结论、方法矩阵、Hamiltonian 与理论假设、计算设置与复现性、结果差异、局限与不可直接比较项、待核查问题。
2. 每个事实必须使用“【P1 p.页码】”格式引用对应论文；只能引用证据中明确给出的论文编号和页码。
3. 方法矩阵应逐篇列出 theory/method、Hamiltonian、关键近似、basis set/functional、electron correlation、software、convergence criteria 与 observable；未确认项写“当前证据未确认”。
4. 比较不同分子、材料、数据集、几何结构或评价指标时，先说明可比性，禁止把体系差异直接归因于方法优劣。
5. 明确区分作者结论与跨文献推断；推断必须标为“跨文献推断”并给出支持它的多篇引用。
6. 保留英文术语、公式与单位，默认使用简洁中文，不要输出代码围栏。`;

const COMPARISON_SEARCH_QUERIES = [
  "Hamiltonian theoretical method approximation wavefunction functional basis set electron correlation",
  "computational details software convergence threshold pseudopotential relativistic geometry reproducibility",
  "main result observable benchmark error uncertainty limitation conclusion",
];

export async function askPaper(
  credentials: ProviderCredentials,
  worker: WorkerClient,
  input: AskPaperInput & { indexDir?: string },
  options: ProviderRequestOptions = {},
): Promise<AskPaperResult> {
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
  const searchQuery = [
    input.question,
    ...selectedSnippets
      .filter((snippet) => !snippet.imageOnly)
      .map((snippet) => snippet.text.slice(0, 700)),
  ]
    .filter(Boolean)
    .join("\n");
  const hits = await worker.request<SearchHit[]>("search", {
    paper_id: input.paperId,
    query: searchQuery,
    current_page: input.currentPage ?? null,
    index_dir: input.indexDir,
    limit: 10,
  });
  throwIfAborted(options.signal);
  if (hits.length === 0 && selectedSnippets.length === 0) {
    throw new Error("尚未检索到可用论文内容，请等待文献解析完成。");
  }
  const textSnippets = selectedSnippets.filter(
    (snippet) => !snippet.imageOnly && snippet.text,
  );
  for (let index = textSnippets.length - 1; index >= 0; index -= 1) {
    const snippet = textSnippets[index];
    hits.unshift({
      chunk_id: `${input.paperId}:selection:${index + 1}:p${snippet.page}`,
      page: snippet.page,
      text: snippet.text.slice(0, 8_000),
      score: 1,
    });
  }

  const context = hits
    .map(
      (hit) => `[PAGE ${hit.page} | CHUNK ${hit.chunk_id}]\n${hit.text.trim()}`,
    )
    .join("\n\n");
  const recent = input.messages.slice(-8).map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const imageSelectionSummary = selectedSnippets
    .filter((snippet) => snippet.imageDataUrl)
    .map(
      (snippet) =>
        `- p.${snippet.page} 的图片选区（已作为图片附件提供）。IMPORTANT: Inspect this image first. For formulas, transcribe the visible symbols before explaining them; do not infer unseen symbols.`,
    )
    .join("\n");
  const userPrompt = `论文证据如下：\n\n${context || "未检索到额外文本证据。"}${
    imageSelectionSummary
      ? `\n\n用户选择的图片：\n${imageSelectionSummary}`
      : ""
  }\n\n用户问题：${input.question}`;
  const { content, protocol } = await completeWithProvider(
    credentials,
    SYSTEM_PROMPT,
    recent,
    userPrompt,
    input.reasoningEffort,
    options.signal,
    selectedSnippets,
  );

  const message: ChatMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    content,
    citations: extractCitations(content, hits),
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
  worker: WorkerClient,
  input: { paperId: string; title: string; indexDir?: string },
): Promise<Omit<GeneratePaperNoteResult, "note"> & { content: string }> {
  const uniqueHits = new Map<string, SearchHit>();
  for (const query of NOTE_SEARCH_QUERIES) {
    const hits = await worker.request<SearchHit[]>("search", {
      paper_id: input.paperId,
      query,
      current_page: null,
      index_dir: input.indexDir,
      limit: 6,
    });
    for (const hit of hits) {
      const existing = uniqueHits.get(hit.chunk_id);
      if (!existing || hit.score > existing.score) {
        uniqueHits.set(hit.chunk_id, hit);
      }
    }
  }
  const hits = [...uniqueHits.values()]
    .sort((a, b) => a.page - b.page || b.score - a.score)
    .slice(0, 24);
  if (hits.length === 0) {
    throw new Error("尚未检索到可用论文内容，请等待文献解析完成。");
  }
  const context = hits
    .map(
      (hit) => `[PAGE ${hit.page} | CHUNK ${hit.chunk_id}]\n${hit.text.trim()}`,
    )
    .join("\n\n");
  const userPrompt = `论文标题：${input.title}\n\n论文证据如下：\n\n${context}\n\n请生成结构化阅读笔记。`;
  const result = await completeWithProvider(
    credentials,
    NOTE_SYSTEM_PROMPT,
    [],
    userPrompt,
  );
  return { ...result, model: credentials.model };
}

export async function comparePapers(
  credentials: ProviderCredentials,
  worker: WorkerClient,
  input: {
    papers: Array<{ id: string; title: string }>;
    question: string;
    indexDir?: string;
  },
): Promise<Omit<ComparisonReport, "id" | "createdAt">> {
  if (input.papers.length < 2 || input.papers.length > 5) {
    throw new Error("请选择 2 至 5 篇已完成索引的文献。");
  }
  const question = input.question.trim();
  if (!question) throw new Error("请输入跨文献研究问题。");
  if (question.length > 2000) {
    throw new Error("跨文献研究问题不能超过 2,000 个字符。");
  }

  const sources: ComparisonSource[] = [];
  for (const [index, paper] of input.papers.entries()) {
    const paperLabel = `P${index + 1}`;
    const uniqueHits = new Map<string, SearchHit>();
    for (const query of [question, ...COMPARISON_SEARCH_QUERIES]) {
      const hits = await worker.request<SearchHit[]>("search", {
        paper_id: paper.id,
        query,
        current_page: null,
        index_dir: input.indexDir,
        limit: 4,
      });
      for (const hit of hits) {
        const existing = uniqueHits.get(hit.chunk_id);
        if (!existing || hit.score > existing.score) {
          uniqueHits.set(hit.chunk_id, hit);
        }
      }
    }
    const hits = [...uniqueHits.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 7)
      .sort((a, b) => a.page - b.page);
    if (hits.length === 0) {
      throw new Error(`“${paper.title}”尚未检索到可用证据。`);
    }
    sources.push(
      ...hits.map((hit) => ({
        paperId: paper.id,
        paperLabel,
        chunk_id: hit.chunk_id,
        page: hit.page,
        text: hit.text,
      })),
    );
  }

  const context = input.papers
    .map((paper, index) => {
      const paperLabel = `P${index + 1}`;
      const evidence = sources
        .filter((source) => source.paperId === paper.id)
        .map(
          (source) =>
            `[${paperLabel} | PAGE ${source.page} | CHUNK ${source.chunk_id}]\n${source.text.trim()}`,
        )
        .join("\n\n");
      return `${paperLabel} 标题：${paper.title}\n\n${evidence}`;
    })
    .join("\n\n==========\n\n");
  const userPrompt = `研究问题：${question}\n\n跨文献证据如下：\n\n${context}\n\n请生成跨文献研究矩阵。`;
  const result = await completeWithProvider(
    credentials,
    COMPARISON_SYSTEM_PROMPT,
    [],
    userPrompt,
  );
  return {
    paperIds: input.papers.map((paper) => paper.id),
    question,
    content: result.content,
    citations: extractComparisonCitations(result.content, sources),
    protocol: result.protocol,
    model: credentials.model,
  };
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
  reasoningEffort: ModelReasoningEffort = "default",
  signal?: AbortSignal,
  selectedSnippets: Array<{ imageDataUrl?: string }> = [],
): Promise<{
  content: string;
  protocol: Exclude<ProviderProtocol, "auto">;
}> {
  const client = new OpenAI({
    apiKey: credentials.apiKey,
    baseURL: credentials.baseUrl,
    timeout: 120_000,
    maxRetries: 1,
  });
  if (credentials.protocol === "chat-completions") {
    return {
      protocol: "chat-completions",
      content: await askWithChatCompletions(
        client,
        credentials.model,
        instructions,
        history,
        userPrompt,
        reasoningEffort,
        signal,
        selectedSnippets,
      ),
    };
  }
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
      ),
  );
  return { protocol, content: value };
}

async function runWithResolvedProtocol<T>(
  protocol: ProviderProtocol,
  runResponses: () => Promise<T>,
  runChatCompletions: () => Promise<T>,
): Promise<{
  protocol: Exclude<ProviderProtocol, "auto">;
  value: T;
  fellBack: boolean;
}> {
  if (protocol === "chat-completions") {
    return {
      protocol: "chat-completions",
      value: await runChatCompletions(),
      fellBack: false,
    };
  }
  if (protocol === "responses") {
    return {
      protocol: "responses",
      value: await runResponses(),
      fellBack: false,
    };
  }
  try {
    return {
      protocol: "responses",
      value: await runResponses(),
      fellBack: false,
    };
  } catch (error) {
    if (!shouldFallbackToChatCompletions(error)) {
      throw error;
    }
    return {
      protocol: "chat-completions",
      value: await runChatCompletions(),
      fellBack: true,
    };
  }
}

async function probeWithResponses(
  client: OpenAI,
  model: string,
): Promise<void> {
  await client.responses.create({
    model,
    input: "Reply with OK.",
    store: false,
  });
}

async function probeWithChatCompletions(
  client: OpenAI,
  model: string,
): Promise<void> {
  await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: "Reply with OK." }],
  });
}

async function askWithResponses(
  client: OpenAI,
  model: string,
  instructions: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  userPrompt: string,
  reasoningEffort: ModelReasoningEffort,
  signal?: AbortSignal,
  selectedSnippets: Array<{ imageDataUrl?: string }> = [],
): Promise<string> {
  const response = await client.responses.create(
    {
      model,
      instructions,
      input: [
        ...history.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        {
          role: "user" as const,
          content: [
            { type: "input_text" as const, text: userPrompt },
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
          ],
        },
      ],
      reasoning:
        reasoningEffort === "default" ? undefined : { effort: reasoningEffort },
      store: false,
    },
    { signal },
  );
  if (!response.output_text) throw new Error("模型未返回文本内容。");
  return response.output_text;
}

async function askWithChatCompletions(
  client: OpenAI,
  model: string,
  instructions: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  userPrompt: string,
  reasoningEffort: ModelReasoningEffort,
  signal?: AbortSignal,
  selectedSnippets: Array<{ imageDataUrl?: string }> = [],
): Promise<string> {
  const response = await client.chat.completions.create(
    {
      model,
      messages: [
        { role: "system", content: instructions },
        ...history,
        {
          role: "user",
          content: [
            { type: "text", text: userPrompt },
            ...selectedSnippets
              .map((snippet) => snippet.imageDataUrl)
              .filter((imageDataUrl): imageDataUrl is string =>
                Boolean(imageDataUrl),
              )
              .slice(0, 3)
              .map((imageDataUrl) => ({
                type: "image_url" as const,
                image_url: { url: imageDataUrl, detail: "high" as const },
              })),
          ],
        },
      ],
      reasoning_effort:
        reasoningEffort === "default" ? undefined : reasoningEffort,
    },
    { signal },
  );
  const content = response.choices[0]?.message.content;
  if (!content) throw new Error("模型未返回文本内容。");
  return content;
}

function redactError(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("Request aborted", "AbortError");
}
