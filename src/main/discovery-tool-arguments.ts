import type { PaperAgentTool } from "../shared/paperAgent";

type JsonObject = Record<string, unknown>;
export interface DiscoveryArgumentIssue {
  path: string;
  message: string;
}
export class DiscoveryToolArgumentError extends Error {
  readonly code = "invalid_tool_arguments";
  constructor(
    readonly tool: PaperAgentTool,
    readonly issues: DiscoveryArgumentIssue[],
  ) {
    super(
      `参数格式需要修正：${issues.map((issue) => `${issue.path} ${issue.message}`).join("；")}`,
    );
  }
  feedback() {
    return {
      error: this.message,
      code: this.code,
      tool: this.tool.name,
      issues: this.issues,
      expectedSchema: this.tool.parameters,
      retry:
        "按 expectedSchema 修正本次调用后重试。参数必须是 JSON 对象；不要重复检索或放宽候选、PDF 页码的证据要求。",
    };
  }
}

/** Normalize syntax only. Candidate identities, evidence and update semantics are never inferred. */
export function parseDiscoveryToolArguments(tool: PaperAgentTool, raw: string) {
  const normalized: string[] = [];
  if (raw.length > 96000)
    throw new DiscoveryToolArgumentError(tool, [
      {
        path: "$",
        message: "参数超过 96000 字符，请缩短说明或减少本次推荐数量。",
      },
    ]);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DiscoveryToolArgumentError(tool, [
      { path: "$", message: "不是有效 JSON，请使用双引号并检查括号和逗号。" },
    ]);
  }

  if (tool.name === "recommend_papers") {
    // Some compatible endpoints return a JSON string inside the argument string.
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
        normalized.push("解析重复编码的 JSON 参数");
      } catch {
        /* The validator below reports the required object shape. */
      }
    }
    if (Array.isArray(value)) {
      value = { recommendations: value };
      normalized.push("将推荐数组放入 recommendations 字段");
    } else if (isObject(value)) {
      const object = value;
      const aliases = [
        "papers",
        "items",
        "candidates",
        "recommended_papers",
      ].filter((key) => Object.hasOwn(object, key));
      if (
        !Object.hasOwn(value, "recommendations") &&
        aliases.length === 1 &&
        Array.isArray(value[aliases[0]])
      ) {
        value = { ...value, recommendations: value[aliases[0]] };
        delete (value as JsonObject)[aliases[0]];
        normalized.push(`将 ${aliases[0]} 字段映射为 recommendations`);
      }
      if (isObject(value) && Object.hasOwn(value, "recommendations")) {
        // These fields explain the call; they cannot alter the complete-shortlist operation.
        for (const key of ["explanation", "summary"]) {
          if (
            Object.hasOwn(value, key) &&
            (typeof value[key] === "string" || value[key] === null)
          ) {
            delete value[key];
            normalized.push(`忽略不影响推荐内容的 ${key} 字段`);
          }
        }
      }
    }
  }

  const issues: DiscoveryArgumentIssue[] = [];
  validate(value, tool.parameters, "$", issues, normalized);
  if (issues.length) throw new DiscoveryToolArgumentError(tool, issues);
  return { args: value as JsonObject, normalized };
}

function validate(
  value: unknown,
  schema: JsonObject,
  path: string,
  issues: DiscoveryArgumentIssue[],
  normalized: string[],
) {
  if (issues.length >= 8) return;
  const issue = (message: string) => issues.push({ path, message });
  if (schema.type === "object") {
    if (!isObject(value)) {
      issue("应为 JSON 对象。");
      return;
    }
    const properties = (schema.properties ?? {}) as Record<string, JsonObject>;
    const required = (schema.required ?? []) as string[];
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        if (issues.length < 8)
          issues.push({
            path: fieldPath(path, key),
            message: `不是支持的字段。此处支持：${Object.keys(properties).join("、") || "无字段"}。`,
          });
      } else if (value[key] === null && !required.includes(key)) {
        delete value[key];
        normalized.push(`省略空的可选字段 ${fieldPath(path, key)}`);
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key)) {
        if (required.includes(key) && issues.length < 8)
          issues.push({
            path: fieldPath(path, key),
            message: "缺少必填字段。",
          });
      } else
        validate(value[key], child, fieldPath(path, key), issues, normalized);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) {
      issue("应为数组。");
      return;
    }
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      issue(`至少需要 ${schema.minItems} 项。`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      issue(`最多允许 ${schema.maxItems} 项。`);
    if (isObject(schema.items))
      value.forEach((item, index) =>
        validate(
          item,
          schema.items as JsonObject,
          `${path}[${index}]`,
          issues,
          normalized,
        ),
      );
  } else if (schema.type === "string") {
    if (typeof value !== "string") {
      issue("应为字符串。");
      return;
    }
    if (
      typeof schema.minLength === "number" &&
      value.trim().length < schema.minLength
    )
      issue("不能为空。");
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      issue(`不能超过 ${schema.maxLength} 字符。`);
  } else if (schema.type === "integer") {
    if (!Number.isSafeInteger(value)) {
      issue("应为整数。");
      return;
    }
    if (typeof schema.minimum === "number" && Number(value) < schema.minimum)
      issue(`不能小于 ${schema.minimum}。`);
    if (typeof schema.maximum === "number" && Number(value) > schema.maximum)
      issue(`不能大于 ${schema.maximum}。`);
  }
}
function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fieldPath(parent: string, key: string) {
  const name = key.length > 80 ? `${key.slice(0, 80)}…` : key;
  return /^[A-Za-z_][\w]*$/.test(name)
    ? `${parent}.${name}`
    : `${parent}[${JSON.stringify(name)}]`;
}
