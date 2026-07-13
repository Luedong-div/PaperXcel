import { app } from "electron";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { WorkerStatus } from "../shared/contracts";
import { DocumentEngine } from "./document-engine";

export class WorkerClient extends EventEmitter {
  private engine?: DocumentEngine;
  private startError?: string;

  async start(): Promise<void> {
    if (this.engine) return;
    try {
      const modelDirectory = app.isPackaged
        ? join(process.resourcesPath, "models", "bge-small-zh-v1.5")
        : join(app.getAppPath(), "models", "bge-small-zh-v1.5");
      const require = createRequire(import.meta.url);
      const standardFontDirectory = join(
        dirname(require.resolve("pdfjs-dist/package.json")),
        "standard_fonts",
      );
      const wasmDirectory = join(
        dirname(require.resolve("pdfjs-dist/package.json")),
        "wasm",
      );
      this.engine = new DocumentEngine(
        modelDirectory,
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
        semanticSearch: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  stop(): void {
    this.engine = undefined;
  }
}
