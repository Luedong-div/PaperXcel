import type { ChatProgress, TokenUsage, ProviderProtocol } from "./contracts";

export interface PaperAgentPlanStep {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
}

export interface PaperAgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface PaperAgentToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface PaperAgentToolResult {
  callId: string;
  output: string;
}

export interface PaperAgentTurn {
  content: string;
  toolCalls: PaperAgentToolCall[];
  reasoningObserved?: boolean;
  tokenUsage?: TokenUsage;
  protocol: Exclude<ProviderProtocol, "auto">;
  model: string;
  contextCheckpoint?: string;
  contextUsage?: import("./assistantContext").AssistantContextUsage;
}

/** The adapter owns native conversation items, including tool calls and reasoning. */
export interface PaperAgentSession {
  next(results?: PaperAgentToolResult[]): Promise<PaperAgentTurn>;
}

export interface PaperAgentSessionOptions {
  signal?: AbortSignal;
  onProgress?: (progress: Omit<ChatProgress, "requestId">) => void;
}
