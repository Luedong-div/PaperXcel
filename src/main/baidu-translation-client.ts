import { createHash, randomBytes } from "node:crypto";
import type {
  TranslationResult,
  TranslationTestResult,
} from "../shared/contracts";
import { detectTranslationDirection } from "../shared/translation";

const BAIDU_TRANSLATION_ENDPOINT =
  "https://fanyi-api.baidu.com/api/trans/vip/translate";
const MAX_TRANSLATION_CHARACTERS = 2_000;

interface BaiduTranslationItem {
  src?: string;
  dst?: string;
}

interface BaiduTranslationPayload {
  from?: string;
  to?: string;
  trans_result?: BaiduTranslationItem[];
  error_code?: string;
  error_msg?: string;
}

const BAIDU_ERROR_MESSAGES: Record<string, string> = {
  "52000": "百度翻译请求成功但没有返回译文。",
  "52001": "百度翻译请求超时，请重试。",
  "52002": "百度翻译系统错误，请稍后重试。",
  "52003": "百度翻译未授权，请检查 APP ID。",
  "54000": "百度翻译请求参数不完整。",
  "54001": "百度翻译签名错误，请检查 APP ID 和密钥是否匹配。",
  "54003": "百度翻译请求过于频繁，请稍后重试。",
  "54004": "百度翻译账户余额不足或额度已用尽。",
  "54005": "选中文字过长，请缩短后重试。",
  "58000": "当前设备 IP 不在百度翻译允许范围内。",
  "58001": "百度翻译暂不支持该语言方向。",
  "58002": "百度翻译服务已关闭，请在控制台重新开通。",
  "90107": "百度翻译账户尚未完成认证。",
};

export function createBaiduTranslationSign(
  appId: string,
  text: string,
  salt: string,
  secretKey: string,
): string {
  return createHash("md5")
    .update(`${appId}${text}${salt}${secretKey}`, "utf8")
    .digest("hex");
}

export class BaiduTranslationClient {
  constructor(
    private readonly appId: string,
    private readonly secretKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly createSalt: () => string = () =>
      randomBytes(8).toString("hex"),
  ) {}

  async translate(input: string): Promise<TranslationResult> {
    const text = input.replace(/\s+/g, " ").trim();
    if (!text) throw new Error("请选择需要翻译的文字。");
    if (text.length > MAX_TRANSLATION_CHARACTERS) {
      throw new Error("一次划词翻译不能超过 2,000 个字符。");
    }
    if (!this.appId || !this.secretKey) {
      throw new Error("请先在应用设置中配置百度翻译 APP ID 和密钥。");
    }

    const { source, target } = detectTranslationDirection(text);
    const salt = this.createSalt();
    const body = new URLSearchParams({
      q: text,
      from: source,
      to: target,
      appid: this.appId,
      salt,
      sign: createBaiduTranslationSign(this.appId, text, salt, this.secretKey),
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await this.fetchImpl(BAIDU_TRANSLATION_ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": "PaperXcel/0.1",
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`百度翻译请求失败 (${response.status})。`);
      }
      const payload = (await response.json()) as BaiduTranslationPayload;
      if (payload.error_code) {
        throw new Error(
          BAIDU_ERROR_MESSAGES[payload.error_code] ??
            `百度翻译请求失败 (${payload.error_code})${
              payload.error_msg ? `：${payload.error_msg}` : ""
            }`,
        );
      }
      const translatedText = (payload.trans_result ?? [])
        .map((item) => item.dst?.trim())
        .filter((item): item is string => Boolean(item))
        .join("\n");
      if (!translatedText) {
        throw new Error("百度翻译没有返回有效译文。");
      }
      return {
        source,
        target,
        sourceText: text,
        translatedText,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("百度翻译请求超时，请重试。", { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async test(): Promise<TranslationTestResult> {
    try {
      const result = await this.translate("PaperXcel");
      return {
        ok: true,
        detail: `百度翻译连接正常：${result.translatedText}`,
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
