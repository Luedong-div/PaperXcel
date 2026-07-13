import type { TranslationLanguage } from "./contracts";

export interface TranslationDirection {
  source: TranslationLanguage;
  target: TranslationLanguage;
}

export function detectTranslationDirection(text: string): TranslationDirection {
  return /[\u3400-\u9fff]/u.test(text)
    ? { source: "zh", target: "en" }
    : { source: "en", target: "zh" };
}
