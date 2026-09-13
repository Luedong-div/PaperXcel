import { randomUUID, createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  AgentEvent,
  ChatMessage,
  ChatProgress,
} from "../shared/contracts";
import type {
  ResearchConversation,
  ResearchConversationSummary,
  ResearchKind,
  ResearchScope,
  ResearchTurn,
} from "../shared/researchConversation";
import { RESEARCH_CONVERSATION_TITLE_MAX_LENGTH } from "../shared/researchConversation";
import { citationAnalysisSources } from "../shared/citationAnalysisAgent";
import type { CitationAnalysisMemory } from "./citation-analysis-agent";

interface StoredTurn extends ResearchTurn {
  analysisMemory?: CitationAnalysisMemory;
}
interface Manifest extends ResearchConversationSummary {
  version: 1;
  turnIds: string[];
}
const validId = (id: string) =>
  typeof id === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(id);
const clone = <T>(value: T): T => structuredClone(value);

/** One immutable scope per turn. Streams are checkpointed independently of renderer lifetime. */
export class ResearchConversations {
  private active = new Map<
    string,
    {
      manifest: Manifest;
      turn: StoredTurn;
      timer?: ReturnType<typeof setTimeout>;
      writeError?: unknown;
    }
  >();
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    // A process restart cannot resume a native tool request. Keep all partial work, truthfully interrupted.
    for (const summary of this.list()) {
      if (summary.status !== "running") continue;
      const manifest = this.manifest(summary.id);
      for (const id of manifest.turnIds) {
        const turn = this.readTurn(summary.id, id);
        if (turn.status !== "running") continue;
        turn.status = "interrupted";
        turn.error =
          "应用关闭时任务尚未完成；已保存生成内容，可继续追问或重新应用问题。";
        turn.updatedAt = new Date().toISOString();
        this.write(this.turnPath(summary.id, id), turn);
      }
      manifest.status = "interrupted";
      this.write(this.manifestPath(summary.id), manifest);
    }
  }
  private manifestPath(id: string) {
    if (!validId(id)) throw new Error("无效的研究对话编号。");
    return join(this.directory, id, "conversation.json");
  }
  private turnPath(conversationId: string, id: string) {
    this.manifestPath(conversationId);
    if (!validId(id)) throw new Error("无效的研究轮次编号。");
    return join(this.directory, conversationId, `${id}.json`);
  }
  private manifest(id: string): Manifest {
    const cached = this.active.get(id)?.manifest;
    if (cached) return clone(cached);
    const data = JSON.parse(
      readFileSync(this.manifestPath(id), "utf8"),
    ) as Manifest;
    if (data.version !== 1 || data.id !== id || !Array.isArray(data.turnIds))
      throw new Error("研究对话文件格式不受支持。");
    return data;
  }
  private readTurn(conversationId: string, id: string): StoredTurn {
    const active = this.active.get(conversationId)?.turn;
    if (active?.id === id) return clone(active);
    const turn = JSON.parse(
      readFileSync(this.turnPath(conversationId, id), "utf8"),
    ) as StoredTurn;
    if (turn.id !== id || !turn.scope?.snapshot || !Array.isArray(turn.events))
      throw new Error("研究轮次文件不完整。");
    return turn;
  }
  list(kind?: ResearchKind): ResearchConversationSummary[] {
    return readdirSync(this.directory, { withFileTypes: true })
      .flatMap((entry) => {
        if (
          !entry.isDirectory() ||
          !validId(entry.name) ||
          !existsSync(this.manifestPath(entry.name))
        )
          return [];
        try {
          const {
            version: _version,
            turnIds: _ids,
            ...summary
          } = this.manifest(entry.name);
          return !kind || summary.kind === kind ? [summary] : [];
        } catch {
          return [];
        } // A damaged session must not hide all other conversations.
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  get(id: string): ResearchConversation {
    const m = this.manifest(id);
    return {
      id: m.id,
      kind: m.kind,
      title: m.title,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      turns: m.turnIds.map((turnId) => {
        const { analysisMemory: _memory, ...turn } = this.readTurn(id, turnId);
        return turn;
      }),
    };
  }
  rename(id: string, title: string): ResearchConversationSummary {
    if (typeof title !== "string") throw new Error("请输入对话名称。");
    const name = title.replace(/\s+/g, " ").trim();
    if (!name || name.length > RESEARCH_CONVERSATION_TITLE_MAX_LENGTH)
      throw new Error(
        `对话名称应为 1–${RESEARCH_CONVERSATION_TITLE_MAX_LENGTH} 个字符。`,
      );
    const manifest = this.manifest(id);
    if (this.active.has(id))
      throw new Error("对话正在执行任务，请先停止或等待完成。");
    manifest.title = name;
    manifest.updatedAt = new Date().toISOString();
    this.write(this.manifestPath(id), manifest);
    const { version: _version, turnIds: _ids, ...summary } = manifest;
    return summary;
  }
  delete(id: string): void {
    this.manifest(id);
    if (this.active.has(id))
      throw new Error("对话正在执行任务，请先停止或等待完成。");
    const directory = resolve(this.directory);
    const target = resolve(directory, id);
    if (dirname(target) !== directory) throw new Error("无效的研究对话路径。");
    rmSync(target, { recursive: true });
  }
  deleteTurn(id: string, turnId: string): ResearchConversation {
    const original = this.manifest(id);
    const path = this.turnPath(id, turnId);
    if (this.active.has(id))
      throw new Error("对话正在执行任务，请先停止或等待完成。");
    if (!original.turnIds.includes(turnId))
      throw new Error("该轮次不属于这个研究对话，或已被删除。");
    const conversation = this.get(id);
    const turns = conversation.turns.filter((turn) => turn.id !== turnId);
    const last = turns.at(-1);
    const updatedAt = new Date().toISOString();
    const manifest: Manifest = {
      ...original,
      turnIds: turns.map((turn) => turn.id),
      turnCount: turns.length,
      status: last?.status ?? "idle",
      paperTitles: last?.scope.papers.map((paper) => paper.title) ?? [],
      updatedAt,
    };
    // Commit the index first so an interrupted deletion cannot leave a missing
    // turn referenced by the conversation. Restore it if removing the file fails.
    this.write(this.manifestPath(id), manifest);
    try {
      rmSync(path);
    } catch (error) {
      this.write(this.manifestPath(id), original);
      throw error;
    }
    return { ...conversation, updatedAt, turns };
  }
  scope(id: string, turnId: string, kind: ResearchKind): ResearchScope {
    const manifest = this.manifest(id);
    if (manifest.kind !== kind || !manifest.turnIds.includes(turnId))
      throw new Error("原始论文范围不属于这个研究对话。");
    return this.readTurn(id, turnId).scope;
  }
  memory(
    id: string | undefined,
    scope: ResearchScope,
  ): CitationAnalysisMemory | undefined {
    if (!id) return;
    const fingerprint = researchScopeFingerprint(scope);
    for (const turnId of [...this.manifest(id).turnIds].reverse()) {
      const turn = this.readTurn(id, turnId);
      if (
        turn.analysisMemory &&
        researchScopeFingerprint(turn.scope) === fingerprint
      )
        return turn.analysisMemory;
    }
  }
  history(id?: string): ChatMessage[] {
    if (!id) return [];
    return this.get(id).turns.flatMap((turn, index) => {
      const sources = new Map(
        citationAnalysisSources(turn.scope.snapshot).map(({ label, node }) => [
          label,
          node,
        ]),
      );
      // P labels belong to one frozen snapshot. Never feed an old P1 as evidence for today's P1.
      let content = turn.content.replace(
        /\[([^\]]*)\]\(#citation\/(P\d+)\)/g,
        (_match, _label, label: string) => {
          const node = sources.get(label);
          return node
            ? `《${node.title}》(${node.doi || node.id}，历史第 ${index + 1} 轮)`
            : "[历史来源未找到]";
        },
      );
      content = content.replace(
        /\[([^\]]*)\]\(#discovery\/(C\d+)\)/g,
        (_match, _label, label: string) => {
          const discovery = turn.discovery?.result;
          const candidate = discovery?.candidates.find(
            (candidate) => candidate.aiRecommendation?.label === label,
          );
          return candidate
            ? `《${candidate.work.title}》(${candidate.work.doi || candidate.work.id}，历史第 ${index + 1} 轮)`
            : "[历史候选未找到]";
        },
      );
      return [
        {
          id: `${turn.id}-q`,
          role: "user" as const,
          createdAt: turn.createdAt,
          content: `历史第 ${index + 1} 轮，范围：${turn.scope.papers.map((paper) => paper.title).join("；")}，${turn.scope.snapshot.nodes.length} 篇网络文献。\n${turn.question}`,
        },
        {
          id: turn.id,
          role: "assistant" as const,
          createdAt: turn.updatedAt,
          content: `[历史结果状态：${turn.status}；仅供对话背景，来源编号不得直接沿用]\n${content || "本轮未生成报告。"}\n${JSON.stringify(turn.discovery?.result.candidates.map((candidate) => ({ title: candidate.work.title, doi: candidate.work.doi, recommendation: candidate.aiRecommendation })) ?? [])}`,
        },
      ];
    });
  }
  begin(
    kind: ResearchKind,
    input: { requestId: string; conversationId?: string; question: string },
    scope: ResearchScope,
    model: string,
  ) {
    if (!validId(input.requestId)) throw new Error("无效的研究请求编号。");
    const id = input.conversationId || randomUUID();
    if (this.active.has(id))
      throw new Error("这个对话正在执行任务，请先停止或等待完成。");
    const now = new Date().toISOString();
    const manifest: Manifest = input.conversationId
      ? this.manifest(id)
      : {
          version: 1,
          id,
          kind,
          title:
            input.question.trim().slice(0, 64) ||
            scope.papers
              .map((paper) => paper.title)
              .join("；")
              .slice(0, 64),
          createdAt: now,
          updatedAt: now,
          turnIds: [],
          turnCount: 0,
          status: "running",
          paperTitles: [],
        };
    if (manifest.kind !== kind) throw new Error("该对话的研究类型不匹配。");
    const turn: StoredTurn = {
      id: randomUUID(),
      requestId: input.requestId,
      question: input.question,
      createdAt: now,
      updatedAt: now,
      status: "running",
      scope: clone(scope),
      model,
      content: "",
      events: [],
    };
    manifest.turnIds.push(turn.id);
    manifest.turnCount = manifest.turnIds.length;
    manifest.updatedAt = now;
    manifest.status = "running";
    manifest.paperTitles = scope.papers.map((paper) => paper.title);
    mkdirSync(join(this.directory, id), { recursive: true });
    this.write(this.turnPath(id, turn.id), turn);
    this.write(this.manifestPath(id), manifest);
    this.active.set(id, { manifest, turn });
    return { conversationId: id, turnId: turn.id };
  }
  capture(id: string, payload: AgentEvent | ChatProgress) {
    const entry = this.active.get(id);
    if (!entry || payload.requestId !== entry.turn.requestId) return;
    const turn = entry.turn;
    if ("type" in payload) {
      if (payload.metadata?.citationAnalysis)
        turn.research = payload.metadata
          .citationAnalysis as unknown as ResearchTurn["research"];
      if (payload.metadata?.citationDiscovery)
        turn.discovery = payload.metadata
          .citationDiscovery as unknown as ResearchTurn["discovery"];
      const metadata = { ...payload.metadata };
      delete metadata.citationAnalysis;
      delete metadata.citationDiscovery;
      turn.events.push({ ...payload, metadata });
    } else {
      turn.progress = payload;
      turn.content =
        payload.answerContent !== undefined
          ? payload.answerContent
          : turn.content + (payload.answerDelta ?? "");
    }
    turn.updatedAt = new Date().toISOString();
    if (!entry.timer)
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        try {
          this.write(this.turnPath(id, turn.id), turn);
          entry.writeError = undefined;
        } catch (error) {
          entry.writeError = error;
        }
      }, 600);
    entry.timer?.unref?.();
  }
  checkpoint(id: string, memory: CitationAnalysisMemory) {
    const entry = this.active.get(id);
    if (entry) entry.turn.analysisMemory = clone(memory);
  }
  finish(id: string, update: Partial<ResearchTurn>) {
    const entry = this.active.get(id);
    if (!entry) throw new Error("研究任务不存在。");
    clearTimeout(entry.timer);
    Object.assign(entry.turn, update, { updatedAt: new Date().toISOString() });
    entry.manifest.updatedAt = entry.turn.updatedAt;
    entry.manifest.status = entry.turn.status;
    // A final save failure is returned to the user; never claim the report was saved.
    this.write(this.turnPath(id, entry.turn.id), entry.turn);
    this.write(this.manifestPath(id), entry.manifest);
    this.active.delete(id);
  }
  flush() {
    for (const [id, entry] of this.active) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
      this.write(this.turnPath(id, entry.turn.id), entry.turn);
    }
  }
  private write(path: string, data: unknown) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(data), {
        encoding: "utf8",
        flush: true,
      });
      renameSync(temporary, path);
    } finally {
      if (existsSync(temporary)) rmSync(temporary);
    }
  }
}

export function researchScopeFingerprint(scope: ResearchScope) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        paperIds: [...scope.paperIds].sort(),
        mode: scope.mode,
        nodes: [...scope.snapshot.nodes].sort((a, b) =>
          a.id.localeCompare(b.id),
        ),
        edges: [...scope.snapshot.edges].sort((a, b) =>
          a.id.localeCompare(b.id),
        ),
      }),
    )
    .digest("hex");
}
