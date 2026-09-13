import { randomUUID } from "node:crypto";
import type { CitationDiscoveryInput } from "../shared/contracts";
import {
  createCitationDiscoverySession,
  type CitationDiscoverySession,
} from "./citation-discovery-service";

interface SearchSession {
  owner: number;
  fingerprint: string;
  touched: number;
  data: CitationDiscoverySession;
}

export class CitationDiscoveryRuns {
  private sessions = new Map<string, SearchSession>();
  private runs = new Map<
    string,
    { owner: number; cursor: string; controller: AbortController }
  >();
  private watched = new Set<number>();

  watchOwner(owner: number, onDestroyed: (listener: () => void) => void): void {
    if (this.watched.has(owner)) return;
    this.watched.add(owner);
    onDestroyed(() => {
      for (const [key, run] of this.runs)
        if (run.owner === owner) {
          run.controller.abort();
          this.runs.delete(key);
        }
      for (const [key, session] of this.sessions)
        if (session.owner === owner) this.sessions.delete(key);
      this.watched.delete(owner);
    });
  }

  begin(owner: number, input: CitationDiscoveryInput) {
    const now = Date.now();
    for (const [id, session] of this.sessions)
      if (now - session.touched > 20 * 60_000) this.sessions.delete(id);
    const fingerprint = JSON.stringify([
      input.mode ?? "contextual",
      input.query?.trim() ?? "",
      [...(input.paperIds ?? [])].sort(),
      input.filters?.yearFrom,
      input.filters?.yearTo,
      input.filters?.sort ?? "relevance",
      input.filters?.sources ? [...input.filters.sources].sort() : null,
    ]);
    const cursor = input.cursor || randomUUID();
    let session = this.sessions.get(cursor);
    if (
      input.cursor &&
      (!session ||
        session.owner !== owner ||
        session.fingerprint !== fingerprint)
    )
      throw new Error("搜索条件已改变或会话已过期，请重新搜索。");
    if ([...this.runs.values()].some((run) => run.cursor === cursor))
      throw new Error("这一批搜索尚未结束，请等待完成后继续加载。");
    if (!session) {
      session = {
        owner,
        fingerprint,
        touched: now,
        data: createCitationDiscoverySession(),
      };
      this.sessions.set(cursor, session);
    }
    session.touched = now;
    const owned = [...this.sessions]
      .filter(([, value]) => value.owner === owner)
      .sort((a, b) => b[1].touched - a[1].touched);
    for (const [id] of owned.slice(4)) this.sessions.delete(id);
    const requestId = input.requestId || randomUUID();
    const key = `${owner}:${requestId}`;
    for (const run of this.runs.values())
      if (run.owner === owner) run.controller.abort();
    const controller = new AbortController();
    this.runs.set(key, { owner, cursor, controller });
    return {
      cursor,
      requestId,
      session: session.data,
      signal: controller.signal,
      finish: () => {
        if (this.runs.get(key)?.controller === controller)
          this.runs.delete(key);
      },
    };
  }

  cancel(owner: number, requestId: string): boolean {
    const run = this.runs.get(`${owner}:${requestId}`);
    if (!run) return false;
    run.controller.abort();
    return true;
  }
}
