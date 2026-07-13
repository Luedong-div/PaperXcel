const REFERENCE_HEADING = /\breferences\b/i;
const REFERENCE_MARKER =
  /(?:^|\s)(\d{1,3})\s+(?=(?:[A-Z](?:\s*[.-])|Numerical\s+Recipes|International\s+T\s*ables))/g;

export function extractNumberedReferenceCitations(text: string): string[] {
  const heading = REFERENCE_HEADING.exec(text);
  const source = heading ? text.slice(heading.index + heading[0].length) : text;
  const markers = [...source.matchAll(REFERENCE_MARKER)]
    .map((match) => {
      const number = match[1];
      const markerOffset = match[0].lastIndexOf(number);
      return {
        number: Number(number),
        start: (match.index ?? 0) + markerOffset,
        contentStart: (match.index ?? 0) + markerOffset + number.length,
      };
    })
    .filter((marker) => marker.number <= 200);
  const citations = new Map<number, string>();
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const nextMarker = markers[index + 1];
    const citation = cleanReferenceCitation(
      source.slice(marker.contentStart, nextMarker?.start ?? source.length),
    );
    if (!citation) continue;
    const previous = citations.get(marker.number);
    if (!previous || citationQuality(citation) > citationQuality(previous)) {
      citations.set(marker.number, citation);
    }
  }
  return [...citations.entries()]
    .sort(([first], [second]) => first - second)
    .map(([, citation]) => citation);
}

function cleanReferenceCitation(value: string): string {
  return value
    .replace(/\s+\d{3,4}\s+J\s*\.\s*Chem\s*\.\s*Soc[\s\S]*$/i, "")
    .replace(/\bDownloaded on\b[\s\S]*$/i, "")
    .replace(/\s+Paper\s+\d+\/[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

function citationQuality(value: string): number {
  return (/\b(?:18|19|20)\d{2}\b/.test(value) ? 10_000 : 0) + value.length;
}
