import type {
  AgentEvent,
  AskPaperResponse,
  AskPaperResult,
  ChatProgress,
} from "../shared/contracts";
import { toPublicChatProgress } from "./agent-progress";

export type ChatAgentUpdate = Omit<
  AgentEvent,
  "requestId" | "sequence" | "timestamp"
>;
export type ChatProgressUpdate = Omit<
  ChatProgress,
  "requestId" | "sequence" | "paperId"
>;

/** The request owns its sender, cancellation, progress and terminal event. */
export interface ChatSender {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: ChatProgress | AgentEvent): void;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}

export class ChatRun {
  readonly startedAt = Date.now();
  private readonly controller = new AbortController();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private progressSequence = 0;
  private agentSequence = 0;
  private lastActivityAt = this.startedAt;
  private phase: ChatProgress["phase"] = "waiting";
  private finished = false;
  private answer = "";
  private observedAnswer = false;
  private sentAnswer = "";
  private progressTimer?: ReturnType<typeof setTimeout>;
  private latestProgress: ChatProgressUpdate = { phase: "waiting", detail: "" };
  private sentStatus?: Pick<ChatProgressUpdate, "phase" | "detail">;
  private sentReasoningObserved?: boolean;

  constructor(
    readonly requestId: string,
    readonly paperId: string,
    private readonly sender: ChatSender,
  ) {
    sender.once("destroyed", this.cancel);
    if (sender.isDestroyed()) this.cancel();
    this.heartbeat = setInterval(() => {
      const silentForMs = Date.now() - this.lastActivityAt;
      if (this.finished || this.signal.aborted || silentForMs < 5_000) return;
      this.sendProgress({
        phase: this.phase,
        detail: `任务已运行 ${Math.floor((Date.now() - this.startedAt) / 1_000)}s；正在等待当前步骤返回`,
      });
    }, 2_000);
    this.heartbeat.unref?.();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel = (): void => {
    this.controller.abort();
  };

  check(): void {
    this.signal.throwIfAborted();
  }

  /** Race uninterruptible local I/O without allowing its completion to resume a run. */
  async wait<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        this.signal.removeEventListener("abort", abort);
        reject(this.signal.reason);
      };
      this.signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => {
          this.check();
          return operation();
        })
        .then(
          (value) => {
            this.signal.removeEventListener("abort", abort);
            if (this.signal.aborted) reject(this.signal.reason);
            else resolve(value);
          },
          (error: unknown) => {
            this.signal.removeEventListener("abort", abort);
            reject(error);
          },
        );
    });
  }

  progress = (progress: ChatProgressUpdate): void => {
    if (this.finished || this.signal.aborted) return;
    this.lastActivityAt = Date.now();
    this.phase = progress.phase;
    const replacement =
      progress.answerContent !== undefined &&
      (progress.answerContent === "" ||
        !progress.answerContent.startsWith(this.answer));
    if (replacement) this.flushProgress();
    this.latestProgress = {
      phase: progress.phase,
      detail: progress.detail,
      ...(progress.reasoningObserved === undefined
        ? {}
        : { reasoningObserved: progress.reasoningObserved }),
    };
    if (progress.answerContent !== undefined) {
      this.answer = progress.answerContent;
      this.observedAnswer = true;
    } else if (progress.answerDelta !== undefined) {
      this.answer += progress.answerDelta;
      this.observedAnswer = true;
    }
    if (replacement) {
      this.sendProgress({ ...this.latestProgress, answerContent: this.answer });
      this.sentAnswer = this.answer;
      return;
    }
    if (
      this.sentStatus?.phase !== progress.phase ||
      this.sentStatus.detail !== progress.detail ||
      (progress.reasoningObserved !== undefined &&
        progress.reasoningObserved !== this.sentReasoningObserved)
    ) {
      // Status can change immediately while text waits in its own lossless buffer.
      this.sendProgress(this.latestProgress);
    }
    if (this.answer !== this.sentAnswer && !this.progressTimer) {
      this.progressTimer = setTimeout(() => this.flushProgress(), 32);
      this.progressTimer.unref?.();
    }
  };

  event = (event: ChatAgentUpdate): void => {
    if (this.finished || this.signal.aborted) return;
    this.lastActivityAt = Date.now();
    this.sendEvent(event);
  };

  async execute(
    operation: () => Promise<AskPaperResult>,
    completedTitle: string,
  ): Promise<AskPaperResponse> {
    try {
      const result = await this.wait(operation);
      this.check();
      result.message.processingDurationMs = Date.now() - this.startedAt;
      // Always reconcile the stream with the accepted result before its terminal event.
      this.progress({
        phase: "answering",
        detail: completedTitle,
        answerContent: result.message.content,
      });
      this.flushProgress();
      this.finish({
        type: "run.completed",
        title: completedTitle,
        status: "completed",
      });
      return result;
    } catch (error) {
      this.flushProgress();
      if (this.signal.aborted || isChatAbortError(error)) {
        this.finish({
          type: "run.cancelled",
          title: "任务已停止",
          status: "failed",
        });
        return this.observedAnswer
          ? { cancelled: true, answerContent: this.answer }
          : { cancelled: true };
      }
      this.finish({
        type: "run.failed",
        title: "任务执行失败",
        detail: error instanceof Error ? error.message : String(error),
        status: "failed",
      });
      this.cancel();
      throw error;
    } finally {
      this.finished = true;
      clearInterval(this.heartbeat);
      if (this.progressTimer) clearTimeout(this.progressTimer);
      this.progressTimer = undefined;
      this.sender.removeListener("destroyed", this.cancel);
    }
  }

  private finish(event: ChatAgentUpdate): void {
    if (this.finished) return;
    this.finished = true;
    this.sendEvent(event);
  }

  private sendProgress(progress: ChatProgressUpdate): void {
    this.sentStatus = { phase: progress.phase, detail: progress.detail };
    if (progress.reasoningObserved !== undefined)
      this.sentReasoningObserved = progress.reasoningObserved;
    this.send("chat:progress", {
      ...toPublicChatProgress(progress),
      requestId: this.requestId,
      paperId: this.paperId,
      sequence: ++this.progressSequence,
    });
  }

  private flushProgress(): void {
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
    if (!this.observedAnswer || this.answer === this.sentAnswer) return;
    const content = this.answer.startsWith(this.sentAnswer)
      ? { answerDelta: this.answer.slice(this.sentAnswer.length) }
      : { answerContent: this.answer };
    this.sendProgress({ ...this.latestProgress, ...content });
    this.sentAnswer = this.answer;
  }

  private sendEvent(event: ChatAgentUpdate): void {
    this.send("chat:agent-event", {
      ...event,
      requestId: this.requestId,
      sequence: ++this.agentSequence,
      timestamp: new Date().toISOString(),
    });
  }

  private send(channel: string, payload: ChatProgress | AgentEvent): void {
    if (this.sender.isDestroyed()) return;
    try {
      this.sender.send(channel, payload);
    } catch {
      // A renderer can disappear between isDestroyed() and send().
      this.cancel();
    }
  }
}

export class ChatRunRegistry {
  private readonly owners = new Map<number, Map<string, ChatRun>>();

  async execute(
    sender: ChatSender,
    input: { requestId?: string; paperId: string },
    operation: (run: ChatRun) => Promise<AskPaperResult>,
    completedTitle: string,
  ): Promise<AskPaperResponse> {
    const requestId = input.requestId || crypto.randomUUID();
    const requests = this.owners.get(sender.id) ?? new Map<string, ChatRun>();
    if (requests.has(requestId))
      throw new Error("该问答请求正在执行，请勿重复提交。");
    const run = new ChatRun(requestId, input.paperId, sender);
    requests.set(requestId, run);
    this.owners.set(sender.id, requests);
    try {
      return await run.execute(() => operation(run), completedTitle);
    } finally {
      if (requests.get(requestId) === run) requests.delete(requestId);
      if (!requests.size) this.owners.delete(sender.id);
    }
  }

  cancel(senderId: number, requestId: string): boolean {
    const run = this.owners.get(senderId)?.get(requestId);
    if (!run) return false;
    run.cancel();
    return true;
  }

  cancelAll(): void {
    for (const requests of this.owners.values()) {
      for (const run of requests.values()) run.cancel();
    }
  }
}

export function isChatAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
