// Editing the working copy (image.jpg). Every edit is re-applied from the
// untouched original.* in one pass, so quality never degrades and "Reset"
// simply means "no edits". The person's own photo is never involved.

import { invoke } from "@tauri-apps/api/core";

export interface Edits {
  /** Quarter turns clockwise. */
  rotate: 0 | 90 | 180 | 270;
  /** Crop rectangle, as fractions of the rotated image. */
  crop: { x: number; y: number; w: number; h: number };
  /** -100 to 100. */
  brightness: number;
  contrast: number;
  autoEnhance: boolean;
}

export const NO_EDITS: Edits = { rotate: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, brightness: 0, contrast: 0, autoEnhance: false };

export const isUnedited = (e: Edits) => JSON.stringify(e) === JSON.stringify(NO_EDITS);

export const normalizePath = (p: string) => p.replace(/\\/g, "/");

/** Decode any photo the app can read (HEIC included on a Mac) into an upright JPEG. */
export async function uprightJpeg(path: string, maxLongEdge?: number | null): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>("render_jpeg", { path, maxLongEdge: maxLongEdge ?? null, quality: 95 }));
}

export async function thumbnailOf(path: string, max = 320): Promise<string> {
  const bytes = await invoke<ArrayBuffer>("thumbnail", { path, max });
  return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
}

export async function bitmapOf(jpeg: Uint8Array): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
}

/** Stretch each channel so its darkest and lightest 0.5% reach black and white. */
function autoLevels(d: Uint8ClampedArray) {
  for (let c = 0; c < 3; c++) {
    const hist = new Uint32Array(256);
    for (let i = c; i < d.length; i += 4) hist[d[i]]++;
    const n = d.length / 4;
    let lo = 0, hi = 255, acc = 0;
    while (lo < 255 && (acc += hist[lo]) < n * 0.005) lo++;
    acc = 0;
    while (hi > 0 && (acc += hist[hi]) < n * 0.005) hi--;
    if (hi - lo < 10) continue;
    const scale = 255 / (hi - lo);
    for (let i = c; i < d.length; i += 4) d[i] = (d[i] - lo) * scale;
  }
}

function adjust(d: Uint8ClampedArray, brightness: number, contrast: number) {
  const b = brightness * 1.28;
  const k = (259 * (contrast * 1.28 + 255)) / (255 * (259 - contrast * 1.28));
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) d[i + c] = k * (d[i + c] + b - 128) + 128;
  }
}

/** Apply the edits to the decoded original; returns a canvas of the result. */
export function render(src: ImageBitmap, e: Edits): HTMLCanvasElement {
  const turned = e.rotate === 90 || e.rotate === 270;
  const rw = turned ? src.height : src.width;
  const rh = turned ? src.width : src.height;
  const crop = { x: Math.round(e.crop.x * rw), y: Math.round(e.crop.y * rh), w: Math.max(1, Math.round(e.crop.w * rw)), h: Math.max(1, Math.round(e.crop.h * rh)) };
  const canvas = document.createElement("canvas");
  canvas.width = crop.w;
  canvas.height = crop.h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.save();
  ctx.translate(-crop.x, -crop.y);
  ctx.translate(rw / 2, rh / 2);
  ctx.rotate((e.rotate * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  ctx.restore();
  if (e.autoEnhance || e.brightness || e.contrast) {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (e.autoEnhance) autoLevels(img.data);
    if (e.brightness || e.contrast) adjust(img.data, e.brightness, e.contrast);
    ctx.putImageData(img, 0, 0);
  }
  return canvas;
}

export function toJpeg(canvas: HTMLCanvasElement, quality = 0.92): Promise<Uint8Array> {
  return new Promise((ok, fail) =>
    canvas.toBlob(async (b) => (b ? ok(new Uint8Array(await b.arrayBuffer())) : fail(new Error("could not make a JPEG"))), "image/jpeg", quality),
  );
}

export function scaled(canvas: HTMLCanvasElement | ImageBitmap, max: number): HTMLCanvasElement {
  const s = Math.min(1, max / Math.max(canvas.width, canvas.height));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(canvas.width * s));
  out.height = Math.max(1, Math.round(canvas.height * s));
  out.getContext("2d")!.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

/** Turn a face box measured on the unedited image into one on the edited image (null if cropped away). */
export function mapBox(b: { x: number; y: number; w: number; h: number }, e: Edits): { x: number; y: number; w: number; h: number } | null {
  let { x, y, w, h } = b;
  for (let t = 0; t < e.rotate; t += 90) [x, y, w, h] = [1 - y - h, x, h, w];
  const c = e.crop;
  const nx = (x - c.x) / c.w, ny = (y - c.y) / c.h, nw = w / c.w, nh = h / c.h;
  const x0 = Math.max(0, nx), y0 = Math.max(0, ny), x1 = Math.min(1, nx + nw), y1 = Math.min(1, ny + nh);
  if (x1 - x0 < nw * 0.5 || y1 - y0 < nh * 0.5) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The inverse of mapBox: a box on the edited image, back on the unedited (upright) image. */
export function unmapBox(b: { x: number; y: number; w: number; h: number }, e: Edits): { x: number; y: number; w: number; h: number } {
  const c = e.crop;
  let x = c.x + b.x * c.w, y = c.y + b.y * c.h, w = b.w * c.w, h = b.h * c.h;
  for (let t = 0; t < e.rotate; t += 90) [x, y, w, h] = [y, 1 - x - w, h, w];
  return { x, y, w, h };
}
