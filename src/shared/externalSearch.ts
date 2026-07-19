export const GOOGLE_SCHOLAR_SEARCH_URL =
  "https://scholar.google.com/scholar";

export function buildGoogleScholarSearchUrl(query: string): string {
  const normalized = query.replace(/\s+/g, " ").trim();
  const url = new URL(GOOGLE_SCHOLAR_SEARCH_URL);
  url.searchParams.set("hl", "en");
  url.searchParams.set("q", normalized);
  return url.toString();
}
