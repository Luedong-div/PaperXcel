import type { AgentEvent } from "../../shared/contracts";
import type { PaperTextUpdate } from "../../shared/paperText";

export type PaperTextStatus = "running" | "complete" | "interrupted" | "error";
export interface PaperTextSnapshot {
  paperId: string;
  requestId?: string;
  status?: PaperTextStatus;
  update?: PaperTextUpdate;
  events: AgentEvent[];
}

interface TextEvent extends Partial<PaperTextUpdate> {
  requestId: string;
  paperId: string;
  sequence?: number;
  done?: boolean;
  status?: PaperTextStatus;
}

/** Accept only the active paper/request and publish the newest text once per frame. */
export class PaperTextStreamController {
  private snapshot: PaperTextSnapshot = { paperId: "", events: [] };
  private pending = this.snapshot;
  private listeners = new Set<() => void>();
  private requestId?: string;
  private sequence = -1;
  private cancelFrame?: () => void;

  getSnapshot = (): PaperTextSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(
    paperId: string,
    requestId: string,
    content = "",
    context: Partial<Omit<PaperTextUpdate, "content">> = {},
  ): void {
    this.requestId = requestId;
    this.sequence = -1;
    this.pending = {
      paperId,
      requestId,
      status: "running",
      events: [],
      update: {
        phase: "preparing",
        completed: 0,
        total: 0,
        ...context,
        content,
      },
    };
    this.flush();
  }

  receive = (event: TextEvent): void => {
    if (
      event.requestId !== this.requestId ||
      event.paperId !== this.pending.paperId
    )
      return;
    if (event.sequence !== undefined && event.sequence <= this.sequence) return;
    if (event.sequence !== undefined) this.sequence = event.sequence;
    const previous = this.pending.update!;
    this.pending = {
      ...this.pending,
      status: event.status ?? (event.done ? "complete" : this.pending.status),
      update: {
        ...previous,
        mode: event.mode ?? previous.mode,
        unit: event.unit ?? previous.unit,
        currentPage: event.currentPage ?? previous.currentPage,
        batchStartPage: event.batchStartPage ?? previous.batchStartPage,
        batchEndPage: event.batchEndPage ?? previous.batchEndPage,
        skippedPages: event.skippedPages ?? previous.skippedPages,
        content: event.content ?? previous.content,
        committedContent: event.committedContent ?? previous.committedContent,
        phase: event.phase ?? (event.done ? "complete" : "streaming"),
        completed: event.completed ?? previous.completed,
        total: event.total ?? previous.total,
        detail: event.detail ?? previous.detail,
        change: event.change ?? previous.change,
        skipped: event.skipped ?? previous.skipped,
      },
    };
    if (
      event.done ||
      event.status === "interrupted" ||
      event.status === "error"
    ) {
      this.requestId = undefined;
      this.flush();
    } else this.schedule();
  };

  receiveAgent = (event: AgentEvent): void => {
    if (event.requestId !== this.requestId) return;
    if (
      event.type !== "tool.started" &&
      event.type !== "tool.completed" &&
      event.type !== "run.failed" &&
      event.type !== "run.cancelled"
    )
      return;
    this.pending = {
      ...this.pending,
      events: [...this.pending.events, event].slice(-64),
    };
    this.schedule();
  };

  finish(status: PaperTextStatus, content?: string): void {
    this.requestId = undefined;
    this.pending = {
      ...this.pending,
      status,
      update: this.pending.update && {
        ...this.pending.update,
        ...(content !== undefined ? { content } : {}),
        ...(status === "complete" ? { phase: "complete" } : {}),
      },
    };
    this.flush();
  }

  restore(
    paperId: string,
    update: PaperTextUpdate,
    status: PaperTextStatus,
  ): void {
    this.requestId = undefined;
    this.pending = { paperId, update, status, events: [] };
    this.flush();
  }

  clear(paperId = ""): void {
    this.requestId = undefined;
    this.pending = { paperId, events: [] };
    this.flush();
  }

  flush = (): void => {
    this.cancelFrame?.();
    this.cancelFrame = undefined;
    if (this.snapshot === this.pending) return;
    this.snapshot = this.pending;
    this.listeners.forEach((listener) => listener());
  };

  private schedule(): void {
    if (this.cancelFrame) return;
    if (typeof requestAnimationFrame === "function") {
      const frame = requestAnimationFrame(this.flush);
      this.cancelFrame = () => cancelAnimationFrame(frame);
    } else {
      const timer = setTimeout(this.flush, 16);
      this.cancelFrame = () => clearTimeout(timer);
    }
  }
}
