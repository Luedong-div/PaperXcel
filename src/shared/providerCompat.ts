const RESPONSES_FALLBACK_STATUS_CODES = new Set([
  400, 404, 405, 408, 415, 422, 500, 501, 502, 503, 504, 524,
]);

const NON_FALLBACK_STATUS_CODES = new Set([401, 429]);
const TRANSIENT_STATUS_CODES = new Set([
  408, 409, 425, 429, 500, 502, 503, 504, 524,
]);

const UPSTREAM_UNAVAILABLE_PATTERNS = [
  /\bupstream[_ -]?unavailable\b/i,
  /\bupstream service (?:is )?(?:temporarily )?unavailable\b/i,
  /上游服务暂时不可用/,
  /上游服务、网络链路或代理返回异常响应/,
];

const TRANSIENT_NETWORK_PATTERNS = [
  /\brequest timed out\b/i,
  /\bconnection timed out\b/i,
  /\bapi connection timeout\b/i,
  /\bETIMEDOUT\b/i,
  /\bECONNRESET\b/i,
];

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
  if (isUpstreamUnavailableError(error)) {
    return true;
  }
  if (isTransientNetworkError(error)) {
    return true;
  }
  const status = getErrorStatus(error);
  if (status === 403) {
    return false;
  }
  if (status && NON_FALLBACK_STATUS_CODES.has(status)) {
    return false;
  }
  if (status && RESPONSES_FALLBACK_STATUS_CODES.has(status)) {
    return true;
  }

  return RESPONSES_FALLBACK_PATTERNS.some((pattern) =>
    pattern.test(getErrorText(error)),
  );
}

export function isTransientProviderError(error: unknown): boolean {
  if (isUpstreamUnavailableError(error)) return true;
  if (isTransientNetworkError(error)) return true;
  const status = getErrorStatus(error);
  if (status === 403) return false;
  return Boolean(status && TRANSIENT_STATUS_CODES.has(status));
}

export function getProviderRequestId(error: unknown): string | undefined {
  const record = objectRecord(error);
  const nested = objectRecord(record?.error);
  const candidates = [
    nested?.request_id,
    record?.request_id,
    record?.requestID,
    providerHeader(record?.headers, "x-oneapi-request-id"),
    providerHeader(record?.headers, "x-request-id"),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return getErrorText(error).match(/\brequest_id:\s*([A-Za-z0-9_-]+)/i)?.[1];
}

function isUpstreamUnavailableError(error: unknown): boolean {
  const text = getErrorText(error);
  return UPSTREAM_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(text));
}

function isTransientNetworkError(error: unknown): boolean {
  const text = [
    objectRecord(error)?.name,
    error instanceof Error ? error.name : "",
    getErrorText(error),
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return TRANSIENT_NETWORK_PATTERNS.some((pattern) => pattern.test(text));
}

function getErrorStatus(error: unknown): number | undefined {
  const status = Number(objectRecord(error)?.status);
  return Number.isFinite(status) && status > 0 ? status : undefined;
}

function getErrorText(error: unknown): string {
  const record = objectRecord(error);
  const nested = objectRecord(record?.error);
  return [
    error instanceof Error ? error.message : "",
    record?.message,
    record?.code,
    record?.type,
    nested?.message,
    nested?.code,
    nested?.type,
    nested?.reason,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function providerHeader(headers: unknown, name: string): string | undefined {
  const record = objectRecord(headers);
  const direct = record?.[name];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const get = record?.get;
  if (typeof get !== "function") return undefined;
  const value = Reflect.apply(get, headers, [name]);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
