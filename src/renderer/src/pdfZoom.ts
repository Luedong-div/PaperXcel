export const PDF_MIN_ZOOM = 0.6;
export const PDF_MAX_ZOOM = 2;
const PDF_ZOOM_STEP = 0.1;

export function nextPdfZoom(currentZoom: number, deltaY: number): number {
  const step = deltaY < 0 ? PDF_ZOOM_STEP : -PDF_ZOOM_STEP;
  return Math.max(
    PDF_MIN_ZOOM,
    Math.min(PDF_MAX_ZOOM, Number((currentZoom + step).toFixed(2))),
  );
}
