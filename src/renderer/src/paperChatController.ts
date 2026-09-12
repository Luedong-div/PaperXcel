import type {
  AgentEvent,
  AgentTraceEvent,
  AskPaperInput,
  AskPaperResponse,
  ChatMessage,
  ChatProgress,
  PaperXcelApi,
  ReferencedSnippet,
} from "../../shared/contracts";

export interface PaperChatRun {
  requestId: string;
  paperId: string;
  startedAt: number;
  status: "preparing" | "running" | "stopping";
  detail: string;
  answer: string;
  reasoningObserved?: boolean;
  events: AgentEvent[];
}

interface WorkspaceSnapshot {
  messages: Record<string, ChatMessage[]>;
  activity?: Pick<PaperChatRun, "paperId" | "requestId" | "status">;
}

interface ActiveRun {
  view: PaperChatRun;
  transportId?: string;
  cancelled: boolean;
  committing: boolean;
  progressSequence: number;
  eventSequence: number;
}

export type SubmitPaperChat = Omit<AskPaperInput, "messages" | "requestId"> & {
  /** An explicit history creates an edited/retried conversation branch. */
  history?: ChatMessage[];
};

type ChatApi = Pick<PaperXcelApi, "chat" | "selectionImages">;

/** Owns request state independently of the selected paper and React renders. */
export class PaperChatController {
  private snapshot: { run?: PaperChatRun } = {};
  private workspace: WorkspaceSnapshot = { messages: {} };
  private listeners = new Set<() => void>();
  private workspaceListeners = new Set<() => void>();
  private loads = new Map<string, Promise<ChatMessage[]>>();
  private revisions = new Map<string, number>();
  private mutations = new Set<string>();
  private active?: ActiveRun;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private disconnect?: () => void;

  constructor(private readonly api: ChatApi) {}

  getSnapshot = (): { run?: PaperChatRun } => this.snapshot;
  getWorkspaceSnapshot = (): WorkspaceSnapshot => this.workspace;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  subscribeWorkspace = (listener: () => void): (() => void) => {
    this.workspaceListeners.add(listener);
    return () => this.workspaceListeners.delete(listener);
  };

  connect = (): (() => void) => {
    if (this.disconnect) return this.disconnect;
    const offProgress = this.api.chat.onProgress(this.receiveProgress);
    const offEvent = this.api.chat.onAgentEvent(this.receiveEvent);
    this.disconnect = () => {
      offProgress();
      offEvent();
      if (this.renderTimer) clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
      this.disconnect = undefined;
      void this.cancel().catch(() => undefined);
    };
    return this.disconnect;
  };

  load = (paperId: string): Promise<ChatMessage[]> => {
    const cached = this.workspace.messages[paperId];
    if (cached) return Promise.resolve(cached);
    const pending = this.loads.get(paperId);
    if (pending) return pending;
    const revision = this.revisions.get(paperId) ?? 0;
    const loading = this.api.chat
      .list(paperId)
      .then((history) => {
        if ((this.revisions.get(paperId) ?? 0) === revision) {
          this.setMessages(paperId, history);
        }
        return this.workspace.messages[paperId] ?? history;
      })
      .finally(() => {
        if (this.loads.get(paperId) === loading) this.loads.delete(paperId);
      });
    this.loads.set(paperId, loading);
    return loading;
  };

  clear = async (paperId: string): Promise<void> => {
    this.assertPaperIdle(paperId);
    this.mutations.add(paperId);
    // Invalidate a list request before waiting for IPC, so it cannot restore history.
    this.bumpRevision(paperId);
    try {
      await this.api.chat.clear(paperId);
      this.setMessages(paperId, []);
    } finally {
      this.mutations.delete(paperId);
    }
  };

  forget = (paperId: string): void => {
    this.assertPaperIdle(paperId);
    this.bumpRevision(paperId);
    const messages = { ...this.workspace.messages };
    delete messages[paperId];
    this.workspace = { ...this.workspace, messages };
    this.emitWorkspace();
  };

  remove = async (
    paperId: string,
    removePaper: () => Promise<void>,
  ): Promise<void> => {
    this.assertPaperIdle(paperId);
    this.mutations.add(paperId);
    this.bumpRevision(paperId);
    try {
      await removePaper();
      const messages = { ...this.workspace.messages };
      delete messages[paperId];
      this.workspace = { ...this.workspace, messages };
      this.emitWorkspace();
    } finally {
      this.mutations.delete(paperId);
    }
  };

  isBusy = (): boolean => Boolean(this.active);

  cancel = async (): Promise<boolean> => {
    const run = this.active;
    if (!run || run.committing || run.cancelled) return false;
    const previousStatus = run.view.status;
    run.cancelled = true;
    this.updateRun(run, {
      status: "stopping",
      detail: "正在停止，保留已生成内容",
    });
    if (!run.transportId) return true;
    // Keep ownership until the original submit settles. A late finally can never
    // clear a newer request, and cancellation cannot race another history write.
    try {
      return await this.api.chat.cancel(run.transportId);
    } catch (error) {
      if (this.active === run) {
        run.cancelled = false;
        this.updateRun(run, {
          status: previousStatus,
          detail: "停止请求失败，可再次停止",
        });
      }
      throw error;
    }
  };

  submit = async (input: SubmitPaperChat): Promise<AskPaperResponse> => {
    if (this.active)
      throw new Error("文献助手正在处理请求，请先停止或等待完成。");
    this.assertPaperIdle(input.paperId);
    if (!input.question.trim()) throw new Error("请输入问题。");
    const run: ActiveRun = {
      view: {
        requestId: crypto.randomUUID(),
        paperId: input.paperId,
        startedAt: Date.now(),
        status: "preparing",
        detail: "正在准备论文上下文",
        answer: "",
        events: [],
      },
      cancelled: false,
      committing: false,
      progressSequence: -1,
      eventSequence: -1,
    };
    this.active = run;
    this.publishRun(true);
    let userPersisted = false;
    let terminalCreated = false;
    try {
      const saved = await this.load(input.paperId);
      this.checkCancelled(run);
      let history = input.history ?? saved;
      let context = conversationContext(history);
      if (input.task === "compact") {
        if (!context.length) throw new Error("当前对话还没有可压缩的历史。");
        const result = await this.request(run, { ...input, messages: context });
        this.checkCancelled(run);
        if ("cancelled" in result) return result;
        run.committing = true;
        terminalCreated = true;
        this.updateRun(run, { answer: "", detail: "正在保存上下文摘要" });
        await this.append(
          input.paperId,
          this.completedMessage(run, result.message),
        );
        return result;
      }

      const selectedSnippets = await this.saveReferences(
        input.selectedSnippets ?? [],
      );
      this.checkCancelled(run);
      // A summary is an additional checkpoint. Full readable history is retained.
      if (
        context.length >= 8 &&
        context.reduce((sum, message) => sum + message.content.length, 0) >
          50_000
      ) {
        this.updateRun(run, { detail: "正在压缩对话上下文" });
        const compacted = await this.request(run, {
          paperId: input.paperId,
          question: "请压缩当前历史对话。",
          task: "compact",
          messages: context,
        });
        this.checkCancelled(run);
        if ("cancelled" in compacted) return compacted;
        // Only persist the summary in the branch actually being submitted below.
        history = [...history, { ...compacted.message, task: "compact" }];
        context = [compacted.message];
        this.updateRun(run, {
          answer: "",
          events: [],
          reasoningObserved: false,
          detail: "正在准备论文回答",
        });
      }
      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: input.question.trim(),
        prompt: input.question.trim(),
        task: input.task ?? "qa",
        attachments: input.attachments?.length ? input.attachments : undefined,
        selectedSnippets: selectedSnippets.length
          ? selectedSnippets
          : undefined,
        selectedText: selectedSnippets[0]?.text ?? input.selectedText,
        selectedPage: selectedSnippets[0]?.page ?? input.selectedPage,
        createdAt: new Date().toISOString(),
      };
      if (input.history !== undefined || history !== saved) {
        const persisted = await this.api.chat.replace(input.paperId, [
          ...history,
          userMessage,
        ]);
        this.setMessages(input.paperId, persisted);
      } else {
        await this.append(input.paperId, userMessage);
      }
      userPersisted = true;
      this.checkCancelled(run);
      const result = await this.request(run, {
        ...input,
        selectedSnippets,
        messages: context,
      });
      if ("cancelled" in result) {
        run.cancelled = true;
        if (result.answerContent !== undefined) {
          run.view = { ...run.view, answer: result.answerContent };
        }
      }
      this.checkCancelled(run);
      if ("cancelled" in result) return result;
      run.committing = true;
      terminalCreated = true;
      this.updateRun(run, { answer: "", detail: "正在保存回答" });
      await this.append(
        input.paperId,
        this.completedMessage(run, result.message),
      );
      return result;
    } catch (error) {
      const cancelled = run.cancelled || isAbortError(error);
      if (userPersisted && !terminalCreated) {
        const detail = cancelled ? undefined : errorText(error);
        const trace = buildAgentTrace(run.view.events);
        const terminalType = cancelled ? "run.cancelled" : "run.failed";
        if (!trace.some((event) => event.type === terminalType)) {
          trace.push({
            type: terminalType,
            title: cancelled ? "任务已停止" : "本轮请求失败",
            detail,
            status: "failed",
          });
        }
        const message: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          task: input.task ?? "qa",
          content:
            run.view.answer ||
            (cancelled ? "任务已停止。" : "本轮请求未完成。"),
          status: cancelled ? "cancelled" : "error",
          error: detail,
          reasoningObserved: run.view.reasoningObserved,
          processingDurationMs: Date.now() - run.view.startedAt,
          agentTrace: trace,
          createdAt: new Date().toISOString(),
        };
        try {
          await this.append(input.paperId, message);
        } catch (saveError) {
          // append keeps the message visible when durable storage fails.
          throw new Error(
            `${detail ? `${detail}；` : ""}保存回答失败：${errorText(saveError)}`,
            { cause: saveError },
          );
        }
      }
      if (cancelled) return { cancelled: true };
      throw error;
    } finally {
      if (this.active === run) {
        this.active = undefined;
        this.publishRun(true);
      }
    }
  };

  private async request(
    run: ActiveRun,
    input: AskPaperInput,
  ): Promise<AskPaperResponse> {
    this.checkCancelled(run);
    run.transportId = crypto.randomUUID();
    run.progressSequence = -1;
    run.eventSequence = -1;
    this.updateRun(run, { status: "running" });
    try {
      return await this.api.chat.ask({ ...input, requestId: run.transportId });
    } finally {
      run.transportId = undefined;
    }
  }

  private receiveProgress = (progress: ChatProgress): void => {
    const run = this.active;
    if (
      !run ||
      run.cancelled ||
      progress.requestId !== run.transportId ||
      (progress.paperId && progress.paperId !== run.view.paperId)
    )
      return;
    if (progress.sequence !== undefined) {
      if (progress.sequence <= run.progressSequence) return;
      run.progressSequence = progress.sequence;
    }
    run.view = {
      ...run.view,
      detail: progress.detail || run.view.detail,
      reasoningObserved:
        progress.reasoningObserved ?? run.view.reasoningObserved,
      answer:
        progress.answerContent !== undefined
          ? progress.answerContent
          : run.view.answer + (progress.answerDelta ?? ""),
    };
    this.scheduleRender();
  };

  private receiveEvent = (event: AgentEvent): void => {
    const run = this.active;
    if (
      !run ||
      run.cancelled ||
      event.requestId !== run.transportId ||
      event.sequence <= run.eventSequence
    )
      return;
    run.eventSequence = event.sequence;
    if (
      ["content.delta", "content.snapshot", "progress.updated"].includes(
        event.type,
      )
    )
      return;
    run.view = { ...run.view, events: [...run.view.events, event].slice(-40) };
    this.scheduleRender();
  };

  private async saveReferences(
    references: ReferencedSnippet[],
  ): Promise<ReferencedSnippet[]> {
    return Promise.all(
      references
        .filter(
          (reference) =>
            reference.text.trim() ||
            reference.imageAssetId ||
            reference.imageDataUrl,
        )
        .map(async ({ imageDataUrl, ...reference }) => ({
          ...reference,
          text: reference.text.replace(/\s+/g, " ").trim(),
          imageAssetId:
            reference.imageAssetId ||
            (imageDataUrl
              ? (await this.api.selectionImages.save(imageDataUrl)).id
              : undefined),
        })),
    );
  }

  private completedMessage(run: ActiveRun, message: ChatMessage): ChatMessage {
    return {
      ...message,
      status: "complete",
      agentTrace: buildAgentTrace(run.view.events),
    };
  }

  private async append(paperId: string, message: ChatMessage): Promise<void> {
    const next = [...(this.workspace.messages[paperId] ?? []), message];
    this.setMessages(paperId, next);
    try {
      const persisted = await this.api.chat.append(paperId, message);
      this.setMessages(paperId, persisted);
    } catch (error) {
      this.setMessages(
        paperId,
        next.map((item) =>
          item.id === message.id
            ? {
                ...item,
                status: "error",
                error: `保存消息失败：${errorText(error)}`,
              }
            : item,
        ),
      );
      throw error;
    }
  }

  private setMessages(paperId: string, messages: ChatMessage[]): void {
    this.bumpRevision(paperId);
    this.workspace = {
      ...this.workspace,
      messages: { ...this.workspace.messages, [paperId]: messages },
    };
    this.emitWorkspace();
  }

  private bumpRevision(paperId: string): void {
    this.revisions.set(paperId, (this.revisions.get(paperId) ?? 0) + 1);
  }

  private assertPaperIdle(paperId: string): void {
    if (this.active?.view.paperId === paperId)
      throw new Error("请先停止这篇论文的任务。");
    if (this.mutations.has(paperId))
      throw new Error("正在更新聊天记录，请稍后再试。");
  }

  private checkCancelled(run: ActiveRun): void {
    if (run.cancelled) throw new DOMException("任务已停止", "AbortError");
  }

  private updateRun(run: ActiveRun, patch: Partial<PaperChatRun>): void {
    const statusChanged =
      patch.status !== undefined && patch.status !== run.view.status;
    run.view = { ...run.view, ...patch };
    this.publishRun(statusChanged);
  }

  private scheduleRender(): void {
    if (this.renderTimer) return;
    // Bound Markdown work to 25 updates/second. The latest raw state is always
    // available to completion/cancellation, including deltas not yet rendered.
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.publishRun(false);
    }, 40);
  }

  private publishRun(workspaceChanged: boolean): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    this.snapshot = { run: this.active?.view };
    for (const listener of this.listeners) listener();
    if (workspaceChanged) {
      const view = this.active?.view;
      this.workspace = {
        ...this.workspace,
        activity: view
          ? {
              paperId: view.paperId,
              requestId: view.requestId,
              status: view.status,
            }
          : undefined,
      };
      this.emitWorkspace();
    }
  }

  private emitWorkspace(): void {
    for (const listener of this.workspaceListeners) listener();
  }
}

export function conversationContext(messages: ChatMessage[]): ChatMessage[] {
  const completed = messages.filter(
    (message) => !message.status || message.status === "complete",
  );
  let summaryIndex = -1;
  completed.forEach((message, index) => {
    if (
      message.role === "assistant" &&
      message.task === "compact" &&
      message.content.trim()
    )
      summaryIndex = index;
  });
  return summaryIndex < 0 ? completed : completed.slice(summaryIndex);
}

function buildAgentTrace(events: AgentEvent[]): AgentTraceEvent[] {
  const latestPlan = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "plan.created" && event.metadata?.source === "model",
    );
  const recent = events.slice(-24);
  const trace =
    latestPlan && !recent.includes(latestPlan)
      ? [latestPlan, ...recent.slice(-23)]
      : recent;
  return trace.map(
    ({ type, title, detail, stepId, tool, status, metadata }) => ({
      type,
      title,
      detail,
      stepId,
      tool,
      status,
      metadata,
    }),
  );
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || /aborted|aborterror/i.test(error.message))
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
