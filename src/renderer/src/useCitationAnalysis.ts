import type { CitationAnalysisInput } from "../../shared/citationAnalysisAgent";
import {
  useResearchConversation,
  type ResearchViewState,
} from "./useResearchConversation";
export type CitationAnalysisViewState = ResearchViewState;
export function useCitationAnalysis() {
  const research = useResearchConversation("analysis");
  return {
    ...research,
    start: research.start as (
      input: Omit<CitationAnalysisInput, "requestId">,
    ) => Promise<void>,
  };
}
