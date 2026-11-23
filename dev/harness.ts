// A stand-in for the app's Rust side, so the real front end and the real
// photostories-core can be exercised in an ordinary browser (for screenshots
// and end-to-end checks). Files live in memory; "your photos" are the
// generated samples; recording plays a scripted transcript. Dev only.

import { unzipSync, zipSync } from "fflate";

const files = new Map<string, Uint8Array>();
const dirs = new Set<string>(["/"]);
const norm = (p: string) => ("/" + p).replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
const parent = (p: string) => norm(p).slice(0, norm(p).lastIndexOf("/")) || "/";
function mkdirp(p: string) {
  const parts = norm(p).split("/").filter(Boolean);
  for (let i = 0; i <= parts.length; i++) dirs.add("/" + parts.slice(0, i).join("/"));
}
function put(p: string, b: Uint8Array) {
  mkdirp(parent(p));
  files.set(norm(p), b.slice());
}
const read = (p: string) => {
  const f = files.get(norm(p));
  if (!f) throw `${p}: No such file or directory`;
  return f;
};
function list(p: string) {
  const d = norm(p);
  if (!dirs.has(d)) throw `${p}: No such file or directory`;
  const pre = d === "/" ? "/" : d + "/";
  const out = new Map<string, boolean>();
  for (const x of dirs) if (x !== d && x.startsWith(pre) && !x.slice(pre.length).includes("/")) out.set(x.slice(pre.length), true);
  for (const x of files.keys()) if (x.startsWith(pre) && !x.slice(pre.length).includes("/")) out.set(x.slice(pre.length), false);
  return [...out].map(([name, isDirectory]) => ({ name, isDirectory }));
}
function remove(p: string) {
  const d = norm(p);
  for (const k of [...files.keys()]) if (k === d || k.startsWith(d + "/")) files.delete(k);
  for (const k of [...dirs]) if (k === d || k.startsWith(d + "/")) dirs.delete(k);
}
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function jpegOf(bytes: Uint8Array, max?: number | null, quality = 0.92) {
  const bmp = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]));
  const s = max ? Math.min(1, max / Math.max(bmp.width, bmp.height)) : 1;
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise<Blob>((ok) => c.toBlob((b) => ok(b!), "image/jpeg", quality));
  return new Uint8Array(await blob.arrayBuffer());
}

// Events.
const callbacks = new Map<number, (d: unknown) => void>();
const listeners = new Map<string, number[]>();
let nextId = 1;
function emit(event: string, payload: unknown) {
  for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id, payload });
}

// Recording: a scripted story, revealed a few words at a time.
const SCRIPT = "um so this is the the house we grew up in on Elm Street. My dad built it himself in the summer of 1965 and uh Grandma Rose lived with us.";
let rec: { words: string[]; shown: number; timer: number; paused: boolean } | null = null;

let modelReady = !new URLSearchParams(location.search).has("nomodel");

// The open-file dialog returns whatever the test queued.
(window as any).__picks = [] as string[];

async function handle(cmd: string, a: any, options?: { headers?: Record<string, string> }): Promise<unknown> {
  switch (cmd) {
    case "read_file": return read(a.path).buffer.slice(0);
    case "write_file": return put(decodeURIComponent(options!.headers!["x-path"]), a as Uint8Array);
    case "list_dir": return list(a.path);
    case "exists": return files.has(norm(a.path)) || dirs.has(norm(a.path));
    case "mkdir": return mkdirp(a.path);
    case "remove": return remove(a.path);
    case "size": return read(a.path).length;
    case "sha256": return hex(await crypto.subtle.digest("SHA-256", read(a.path) as Uint8Array<ArrayBuffer>));
    case "copy_file": return put(a.to, read(a.from));
    case "zip_dir": {
      const top = norm(a.dir).split("/").pop()!;
      const tree: Record<string, Uint8Array> = {};
      for (const [k, v] of files) if (k.startsWith(norm(a.dir) + "/")) tree[`${top}/${k.slice(norm(a.dir).length + 1)}`] = v;
      return put(a.zipPath, zipSync(tree, { level: 0 }));
    }
    case "unzip": {
      for (const [k, v] of Object.entries(unzipSync(read(a.zipPath)))) if (!k.endsWith("/")) put(`${a.dir}/${k}`, v);
      return;
    }
    case "list_images": {
      const entries = list(a.dir);
      return {
        photos: entries.filter((e) => !e.isDirectory && /\.(jpe?g|png)$/i.test(e.name)).map((e) => ({ path: norm(`${a.dir}/${e.name}`), name: e.name, size: read(`${a.dir}/${e.name}`).length, modified: 0 })),
        folders: entries.filter((e) => e.isDirectory).map((e) => norm(`${a.dir}/${e.name}`)),
      };
    }
    case "thumbnail": return (await jpegOf(read(a.path), a.max, 0.8)).buffer;
    case "render_jpeg": return (await jpegOf(read(a.path), a.maxLongEdge, (a.quality ?? 92) / 100)).buffer;
    case "model_status": return { name: a.name, present: modelReady, bytes: modelReady ? 487601967 : 0, expected_bytes: 487601967 };
    case "download_model": {
      // With ?nomodel, a first launch: the model arrives over a few seconds.
      for (let got = 0; got <= 10; got++) {
        emit("model-download", { name: a.name, received: got * 48760196, total: 487601967 });
        await new Promise((r) => setTimeout(r, 900));
      }
      modelReady = true;
      return;
    }
    case "preload_model": (window as any).__preloads = ((window as any).__preloads ?? 0) + 1; return modelReady;
    case "start_recording": {
      const words = SCRIPT.split(" ");
      rec = { words, shown: 0, paused: false, timer: window.setInterval(() => {
        if (!rec || rec.paused) return;
        rec.shown = Math.min(rec.words.length, rec.shown + 5);
        const all = rec.words.slice(0, rec.shown).join(" ");
        emit("transcript", { committed: "", partial: all, seconds: rec.shown / 2.5 });
      }, 300) };
      return;
    }
    case "pause_recording": if (rec) rec.paused = true; return;
    case "resume_recording": if (rec) rec.paused = false; return;
    case "stop_recording": {
      if (!rec) throw "not recording";
      clearInterval(rec.timer);
      const text = a.discard ? "" : SCRIPT;
      rec = null;
      return { text, seconds: 12, model: "small", wav: null };
    }
    case "place_name": // stands in for OpenStreetMap; records what would be sent
      ((window as any).__placeCalls ??= []).push([a.lat, a.lon]);
      return JSON.stringify({ suburb: "7th Arrondissement", city: "Paris", state: "Ile-de-France", region: "Metropolitan France", country: "France" });
    case "get_api_key": return null;
    case "set_api_key": case "delete_api_key": return;
    case "plugin:path|resolve_directory": return "/config";
    case "plugin:path|join": return norm(a.paths.join("/"));
    case "plugin:dialog|open": return (window as any).__picks.shift() ?? null;
    case "plugin:event|listen": {
      listeners.set(a.event, [...(listeners.get(a.event) ?? []), a.handler]);
      return a.handler;
    }
    case "plugin:event|unlisten": return;
    default:
      if (cmd.startsWith("plugin:opener|")) return;
      console.error(`harness: no command ${cmd}`);
      throw `harness: no command ${cmd}`;
  }
}

(window as any).__TAURI_INTERNALS__ = {
  invoke: (cmd: string, args: any, options: any) => handle(cmd, args, options),
  transformCallback(cb: (d: unknown) => void) {
    const id = nextId++;
    callbacks.set(id, cb);
    return id;
  },
  convertFileSrc: (p: string) => p,
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
};
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
(window as any).__harness = { files, dirs, emit };

// "Your photos": the generated samples (no real people).
for (const n of ["house", "boat", "hills", "garden"]) {
  put(`/home/demo/Pictures/${n}.jpg`, new Uint8Array(await (await fetch(`/dev/samples/${n}.jpg`)).arrayBuffer()));
}
// ?faces: also load test photos from dev/local/ (git-ignored; synthetic faces only, never committed).
if (new URLSearchParams(location.search).has("faces")) {
  for (const n of ["single", "tall", "wide", "gps", "gps2"]) {
    const r = await fetch(`/dev/local/${n}.jpg`);
    if (r.ok) put(`/home/demo/Pictures/${n}.jpg`, new Uint8Array(await r.arrayBuffer()));
  }
}
mkdirp("/home/demo/Projects");
await import("../src/main.tsx");
