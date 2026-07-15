export function formatProcessingDuration(durationMs?: number): string {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return "";
  if (durationMs <= 0) return "";
  const totalSeconds = Math.max(1, Math.floor(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${totalSeconds}s`;
}
