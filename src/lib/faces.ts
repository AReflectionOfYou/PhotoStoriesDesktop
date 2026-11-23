// From the shared online Photo Stories app (web/src/lib/faces.ts), unchanged.
// Face-box geometry for in-browser detection (pure functions, no DOM).
//
// Detectors look at a small downscaled input, so small faces in group
// photos are easy to miss. We also run the detector on overlapping tiles
// and merge the results, keeping the most confident box where boxes overlap.

/** A face region normalized to the image (0-1), as stored in `faces`. */
export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

export interface Tile {
  /** Pixel rectangle within the image. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The whole image, plus overlapping grids for larger images. */
export function tilesFor(width: number, height: number): Tile[] {
  const tiles: Tile[] = [{ x: 0, y: 0, w: width, h: height }];
  const longest = Math.max(width, height);
  const grids = longest >= 2400 ? [2, 3] : longest >= 900 ? [2] : [];
  for (const n of grids) {
    const overlap = 0.25;
    const tw = width / (n - (n - 1) * overlap);
    const th = height / (n - (n - 1) * overlap);
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        tiles.push({ x: Math.round(col * tw * (1 - overlap)), y: Math.round(row * th * (1 - overlap)), w: Math.round(tw), h: Math.round(th) });
      }
    }
  }
  return tiles;
}

/** Map a detection in tile pixels to a normalized box in the whole image. */
export function toImageBox(tile: Tile, box: { x: number; y: number; w: number; h: number }, score: number, width: number, height: number): FaceBox {
  const x = Math.max(0, (tile.x + box.x) / width);
  const y = Math.max(0, (tile.y + box.y) / height);
  return { x, y, w: Math.min(1 - x, box.w / width), h: Math.min(1 - y, box.h / height), score };
}

export function iou(a: FaceBox, b: FaceBox): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

/** How much of the smaller box lies inside the larger one (catches a face found whole and again as a fragment at a tile edge). */
function containment(a: FaceBox, b: FaceBox): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / Math.min(a.w * a.h, b.w * b.h);
}

/** Non-maximum suppression: keep the most confident of each overlapping cluster, largest first on ties. */
export function mergeBoxes(boxes: FaceBox[], minScore = 0.5): FaceBox[] {
  const sorted = boxes
    .filter((b) => b.score >= minScore && b.w > 0.004 && b.h > 0.004)
    .sort((a, b) => b.score - a.score || b.w * b.h - a.w * a.h);
  const kept: FaceBox[] = [];
  for (const b of sorted) {
    if (kept.every((k) => iou(k, b) < 0.35 && containment(k, b) < 0.6)) kept.push(b);
  }
  return readingOrder(kept);
}

/** Group faces into rows (by vertical centre), then left to right within each row. */
export function readingOrder(boxes: FaceBox[]): FaceBox[] {
  const rows: FaceBox[][] = [];
  for (const b of [...boxes].sort((p, q) => p.y + p.h / 2 - (q.y + q.h / 2))) {
    const row = rows[rows.length - 1];
    const centre = b.y + b.h / 2;
    const rowCentre = row && row.reduce((n, r) => n + r.y + r.h / 2, 0) / row.length;
    const rowHeight = row && row.reduce((n, r) => n + r.h, 0) / row.length;
    if (row && Math.abs(centre - rowCentre) < Math.max(rowHeight, b.h) * 1.5) row.push(b);
    else rows.push([b]);
  }
  return rows.flatMap((row) => row.sort((p, q) => p.x - q.x));
}
