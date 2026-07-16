import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerStatus } from "../shared/contracts";
import { DocumentEngine } from "./document-engine";

const mainDirectory = dirname(fileURLToPath(import.meta.url));

export class DocumentEngineClient extends EventEmitter {
  private engine?: DocumentEngine;
  private startError?: string;

  async start(): Promise<void> {
    if (this.engine) return;
    try {
      const standardFontDirectory = join(
        mainDirectory,
        "../renderer/pdfjs",
        "standard_fonts",
      );
      const wasmDirectory = join(mainDirectory, "../renderer/pdfjs", "wasm");
      this.engine = new DocumentEngine(
        standardFontDirectory,
        wasmDirectory,
        (payload) => {
          this.emit("progress", payload);
        },
      );
    } catch (error) {
      this.startError = error instanceof Error ? error.message : String(error);
    }
  }

  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 180_000,
  ): Promise<T> {
    await this.start();
    if (!this.engine)
      throw new Error(this.startError || "Document engine is unavailable.");
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Document task timed out: ${method}`)),
        timeoutMs,
      );
      timer.unref();
    });
    return Promise.race([
      this.engine.request(method, params) as Promise<T>,
      timeout,
    ]);
  }

  async status(): Promise<WorkerStatus> {
    try {
      return await this.request<WorkerStatus>("health", {}, 10_000);
    } catch (error) {
      return {
        available: false,
        pdfjs: false,
        searchMode: "fuzzy-text",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  stop(): void {
    this.engine = undefined;
  }
}
