import type {
  CitationGraphSnapshot,
  ModelReasoningEffort,
  TokenUsage,
} from "./contracts";
import type { AssistantContextUsage } from "./assistantContext";
import type { ResearchConversationTarget } from "./researchConversation";

export interface CitationAnalysisInput extends ResearchConversationTarget {
  requestId: string;
  paperIds: string[];
  mode: "standard" | "focused-two-hop";
  question?: string;
  reasoningEffort?: ModelReasoningEffort;
}

export interface CitationAnalysisFinding {
  id: string;
  kind: "theme" | "bridge" | "path" | "gap";
  title: string;
  explanation: string;
  nodeIds: string[];
  tentative: boolean;
}

export interface CitationAnalysisCoverage {
  total: number;
  read: number;
  noted: number;
  withAbstract: number;
  readWithAbstract: number;
}

export interface CitationAnalysisState {
  coverage: CitationAnalysisCoverage;
  findings: CitationAnalysisFinding[];
}

export interface CitationAnalysisResult extends CitationAnalysisState {
  conversationId?: string;
  turnId?: string;
  content: string;
  model: string;
  cancelled?: boolean;
  tokenUsage?: TokenUsage;
  contextUsage?: AssistantContextUsage;
}

export function citationAnalysisSources(snapshot: CitationGraphSnapshot) {
  return [...snapshot.nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((node, index) => ({ label: `P${index + 1}`, node }));
}
