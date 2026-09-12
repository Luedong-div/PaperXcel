export interface MarkdownComparison {
  originalCharacters: number;
  repairedCharacters: number;
  originalLines: number;
  repairedLines: number;
  changedLineEstimate: number;
}

export function compareMarkdownVersions(
  original: string,
  repaired: string,
): MarkdownComparison {
  const originalNormalized = normalize(original);
  const repairedNormalized = normalize(repaired);
  const originalLines = originalNormalized
    ? originalNormalized.split("\n")
    : [];
  const repairedLines = repairedNormalized
    ? repairedNormalized.split("\n")
    : [];
  const length = Math.max(originalLines.length, repairedLines.length);
  let changedLineEstimate = 0;
  for (let index = 0; index < length; index += 1) {
    if ((originalLines[index] ?? "") !== (repairedLines[index] ?? "")) {
      changedLineEstimate += 1;
    }
  }
  return {
    originalCharacters: originalNormalized.length,
    repairedCharacters: repairedNormalized.length,
    originalLines: originalLines.length,
    repairedLines: repairedLines.length,
    changedLineEstimate,
  };
}

function normalize(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}
