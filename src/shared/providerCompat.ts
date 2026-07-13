const RESPONSES_FALLBACK_STATUS_CODES = new Set([
  400, 404, 405, 408, 415, 422, 500, 501, 502, 503, 504,
]);

const NON_FALLBACK_STATUS_CODES = new Set([401, 403, 429]);

const RESPONSES_FALLBACK_PATTERNS = [
  /responses?/i,
  /unknown endpoint/i,
  /unknown path/i,
  /not found/i,
  /not implemented/i,
  /unsupported/i,
  /invalid url/i,
  /unrecognized request/i,
  /max_output_tokens/i,
  /\bstore\b/i,
  /\binput\b/i,
  /\breasoning\b/i,
];

export function shouldFallbackToChatCompletions(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const status = getErrorStatus(error);
  if (status && NON_FALLBACK_STATUS_CODES.has(status)) {
    return false;
  }
  if (status && RESPONSES_FALLBACK_STATUS_CODES.has(status)) {
    return true;
  }

  return RESPONSES_FALLBACK_PATTERNS.some((pattern) =>
    pattern.test(error.message),
  );
}

function getErrorStatus(error: Error): number | undefined {
  if (!("status" in error)) return undefined;
  const status = Number((error as Error & { status?: number }).status);
  return Number.isFinite(status) && status > 0 ? status : undefined;
}
