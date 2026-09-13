export interface PaperTextChange {
  id: string;
  page: number;
  source: string;
  content: string;
  status: "streaming" | "completed";
}

export interface PaperTextSkipped {
  images: number;
  references: number;
  publisher: number;
}

/** Provider-authored text snapshots, with a separately validated document draft. */
export interface PaperTextUpdate {
  reportingSummaryActive?: boolean;
  reportingSummaryLevel?: number;
  mode?: "pdf-rebuild";
  unit?: "pages" | "segments";
  currentPage?: number;
  batchStartPage?: number;
  batchEndPage?: number;
  skippedPages?: number[];
  content: string;
  committedContent?: string;
  phase: "preparing" | "streaming" | "complete";
  completed: number;
  total: number;
  detail?: string;
  change?: PaperTextChange;
  skipped?: PaperTextSkipped;
}

export interface PaperTextDraftState {
  reportingSummaryActive?: boolean;
  reportingSummaryLevel?: number;
  mode?: "pdf-rebuild";
  unit?: "pages" | "segments";
  currentPage?: number;
  batchStartPage?: number;
  batchEndPage?: number;
  skippedPages?: number[];
  status: "running" | "interrupted" | "error";
  completed: number;
  total: number;
  detail?: string;
  change?: PaperTextChange;
  skipped?: PaperTextSkipped;
}

export interface PaperNoteStream extends PaperTextUpdate {
  requestId: string;
  paperId: string;
  sequence: number;
  done: boolean;
  status?: "complete" | "interrupted" | "error";
}
