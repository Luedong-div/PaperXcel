import type { TranslationLanguage } from "./contracts";

export interface TranslationDirection {
  source: TranslationLanguage;
  target: TranslationLanguage;
}

export function containsChineseText(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text);
}

export function detectTranslationDirection(text: string): TranslationDirection {
  return containsChineseText(text)
    ? { source: "zh", target: "en" }
    : { source: "en", target: "zh" };
}
