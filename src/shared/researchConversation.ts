import type {
  AgentEvent,
  ChatProgress,
  CitationDiscoveryFilters,
  CitationDiscoveryResult,
  CitationGraphSnapshot,
  ModelReasoningEffort,
} from "./contracts";
import type {
  CitationAnalysisResult,
  CitationAnalysisState,
} from "./citationAnalysisAgent";

export type ResearchKind = "analysis" | "discovery";
export const RESEARCH_CONVERSATION_TITLE_MAX_LENGTH = 120;
export type ResearchStatus =
  | "running"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";
export interface ResearchScope {
  paperIds: string[];
  papers: Array<{ id: string; title: string; doi?: string }>;
  mode: "standard" | "focused-two-hop";
  snapshot: CitationGraphSnapshot;
  filters?: CitationDiscoveryFilters;
}
export interface DiscoveryReading {
  paperId: string;
  title: string;
  pages: number[];
  totalPages: number;
  unavailable?: string;
}
export interface DiscoveryAgentState {
  reading: DiscoveryReading[];
  queries: Array<{ query: string; purpose: string; count: number }>;
  result: CitationDiscoveryResult;
}
export interface ResearchTurn {
  id: string;
  requestId: string;
  question: string;
  createdAt: string;
  updatedAt: string;
  status: ResearchStatus;
  scope: ResearchScope;
  model: string;
  content: string;
  events: AgentEvent[];
  progress?: ChatProgress;
  research?: CitationAnalysisState;
  analysisResult?: CitationAnalysisResult;
  discovery?: DiscoveryAgentState;
  error?: string;
}
export interface ResearchConversation {
  id: string;
  kind: ResearchKind;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: ResearchTurn[];
}
export type ResearchConversationSummary = Omit<
  ResearchConversation,
  "turns"
> & {
  turnCount: number;
  status: ResearchStatus | "idle";
  paperTitles: string[];
};
export interface ResearchConversationTarget {
  conversationId?: string;
  /** Reuse this turn's frozen corpus; omitted means the current selection. */
  scopeTurnId?: string;
}
export interface DiscoveryAgentInput extends ResearchConversationTarget {
  requestId: string;
  paperIds: string[];
  question?: string;
  filters?: CitationDiscoveryFilters;
  reasoningEffort?: ModelReasoningEffort;
}
export interface ResearchRunResult {
  conversationId: string;
  turnId: string;
}
