// Face detection on this computer: MediaPipe's open-source BlazeFace detector,
// bundled with the app (runtime and model), so it works offline and photos
// never leave the computer. It finds face boxes only; it never identifies
// anyone. Adapted from the shared online Photo Stories app.

import type { FaceDetector } from "@mediapipe/tasks-vision";
import wasmBinaryPath from "@mediapipe/tasks-vision/vision_wasm_internal.wasm?url";
import wasmLoaderPath from "@mediapipe/tasks-vision/vision_wasm_internal.js?url";
import { type FaceBox, mergeBoxes, tilesFor, toImageBox } from "./faces";

export const DETECTOR_NAME = "mediapipe-blazeface-full-range@1.2.3+tiles";
const MODELS = ["blaze_face_full_range.tflite", "blaze_face_short_range.tflite"];

let detector: Promise<{ detector: FaceDetector; name: string } | null> | null = null;

function load() {
  detector ??= (async () => {
    try {
      const { FaceDetector } = await import("@mediapipe/tasks-vision");
      for (const model of MODELS) {
        try {
          const d = await FaceDetector.createFromOptions(
            { wasmLoaderPath, wasmBinaryPath },
            { baseOptions: { modelAssetPath: `/models/${model}`, delegate: "CPU" }, runningMode: "IMAGE", minDetectionConfidence: 0.5 },
          );
          return { detector: d, name: model.includes("full") ? DETECTOR_NAME : DETECTOR_NAME.replace("full-range", "short-range") };
        } catch (e) {
          console.warn("face model failed to load", model, e);
        }
      }
    } catch (e) {
      console.warn("face detection unavailable", e);
    }
    return null;
  })();
  return detector;
}

export const warmUpFaceDetector = () => void load();

/** Find faces in an image. Returns null if detection isn't possible. */
export async function detectFaces(image: ImageBitmap | HTMLCanvasElement): Promise<{ faces: FaceBox[]; detector: string } | null> {
  const loaded = await load();
  if (!loaded) return null;
  const { width, height } = image;
  const found: FaceBox[] = [];
  try {
    for (const tile of tilesFor(width, height)) {
      // A fresh canvas per tile: some engines keep the first size they saw for a canvas.
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d")!;
      const scale = Math.min(1, 1280 / Math.max(tile.w, tile.h));
      canvas.width = Math.round(tile.w * scale);
      canvas.height = Math.round(tile.h * scale);
      ctx.drawImage(image, tile.x, tile.y, tile.w, tile.h, 0, 0, canvas.width, canvas.height);
      for (const d of loaded.detector.detect(canvas).detections) {
        const b = d.boundingBox;
        if (b) found.push(toImageBox(tile, { x: b.originX / scale, y: b.originY / scale, w: b.width / scale, h: b.height / scale }, d.categories?.[0]?.score ?? 0, width, height));
      }
      canvas.width = canvas.height = 0;
      await new Promise((r) => setTimeout(r, 0));
    }
    return { faces: mergeBoxes(found), detector: loaded.name };
  } catch (e) {
    console.warn("face detection failed", e);
    return null;
  }
}
