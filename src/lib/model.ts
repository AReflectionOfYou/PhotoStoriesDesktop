// The speech model: one shared download, started in the background when the
// app opens (so it's usually ready by the time someone records), and loaded
// ahead of time when a photo is opened (so Record starts at once).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface ModelStatus { present: boolean; bytes: number; expected_bytes: number }

const downloads = new Map<string, Promise<void>>();
const progress = new Map<string, number>();
const watchers = new Set<() => void>();
const notify = () => watchers.forEach((w) => w());

export const modelStatus = (name: string) => invoke<ModelStatus>("model_status", { name });

/** Download the model if it isn't here yet. Calling again while it downloads returns the same download. */
export function ensureModel(name: string): Promise<void> {
  const running = downloads.get(name);
  if (running) return running;
  const job = (async () => {
    if ((await modelStatus(name)).present) return;
    progress.set(name, 0);
    notify();
    const un = await listen<{ name: string; received: number; total: number }>("model-download", (e) => {
      if (e.payload.name === name && e.payload.total) {
        progress.set(name, e.payload.received / e.payload.total);
        notify();
      }
    });
    try {
      await invoke("download_model", { name });
    } finally {
      un();
      progress.delete(name);
      notify();
    }
  })();
  downloads.set(name, job);
  // A failed download can be tried again later.
  job.catch(() => {}).finally(() => downloads.delete(name));
  return job;
}

/** How far along a download is (0 to 1), or null when none is running. */
export const downloadProgress = (name: string) => progress.get(name) ?? null;

export function watchDownloads(fn: () => void): () => void {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

/** Load the model into memory now, if it's downloaded. Quietly does nothing otherwise. */
export const preloadModel = (name: string) => void invoke("preload_model", { model: name }).catch(() => {});
