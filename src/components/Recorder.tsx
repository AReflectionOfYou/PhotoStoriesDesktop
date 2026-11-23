// Record, pause, stop: the story is transcribed on this computer as it is
// told. The speech model is downloaded once, the first time it's needed.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "preact/hooks";
import { useApp } from "../state";

import { downloadProgress, ensureModel, modelStatus, watchDownloads, type ModelStatus } from "../lib/model";

interface Live { committed: string; partial: string; seconds: number }
export interface Finished { text: string; seconds: number; model: string; wav: string | null }

const mins = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function useModel() {
  const app = useApp();
  const model = app.settings.model;
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [progress, setProgress] = useState<number | null>(downloadProgress(model));
  const [problem, setProblem] = useState("");
  useEffect(() => {
    modelStatus(model).then(setStatus);
    setProgress(downloadProgress(model));
    // Follow the shared download (it may have started in the background when the app opened).
    return watchDownloads(() => {
      const p = downloadProgress(model);
      setProgress(p);
      if (p === null) modelStatus(model).then(setStatus);
    });
  }, [model]);
  async function download() {
    setProblem("");
    try {
      await ensureModel(model);
    } catch (e) {
      setProblem(`The download didn't finish (${e}). Check the internet connection and try again.`);
    }
  }
  return { model, status, progress, problem, download };
}

export function ModelGate({ children }: { children: preact.ComponentChildren }) {
  const m = useModel();
  if (!m.status) return null;
  if (m.status.present) return <>{children}</>;
  return (
    <div class="notice stack">
      <p>To turn speech into text on this computer, Photo Stories needs its {m.model} speech model ({Math.round(m.status.expected_bytes / 1e6)} MB). It's downloaded once; after that, recording works without internet.</p>
      {m.progress === null ? <div><button class="primary" onClick={m.download}>Download the speech model</button></div> : (
        <div class="stack"><div class="progress" role="progressbar" aria-valuenow={Math.round(m.progress * 100)} aria-valuemin={0} aria-valuemax={100}><div style={`width:${m.progress * 100}%`} /></div><span class="small muted">Downloading… {Math.round(m.progress * 100)}%</span></div>
      )}
      {m.problem && <p class="small" role="alert">{m.problem}</p>}
    </div>
  );
}

export function Recorder({ wavPath, onFinished, onBusy, label = "Record the story" }: { wavPath: () => string | null; onFinished(r: Finished): void; onBusy?(busy: boolean): void; label?: string }) {
  const app = useApp();
  const [state, setState] = useState<"idle" | "recording" | "paused" | "finishing">("idle");
  const [live, setLive] = useState<Live>({ committed: "", partial: "", seconds: 0 });
  const [problem, setProblem] = useState("");

  useEffect(() => {
    const subs = [
      listen<Live>("transcript", (e) => setLive(e.payload)),
      listen<string>("transcript-error", (e) => setProblem(e.payload)),
    ];
    return () => subs.forEach((s) => s.then((un) => un()));
  }, []);
  useEffect(() => onBusy?.(state !== "idle"), [state]);
  // Never leave the microphone on when the screen closes.
  useEffect(() => () => void invoke("stop_recording", { discard: true, wav: null }).catch(() => {}), []);

  async function start() {
    setProblem("");
    setLive({ committed: "", partial: "", seconds: 0 });
    try {
      await invoke("start_recording", { model: app.settings.model, names: app.project.people.flatMap((p) => [String(p.display_name), ...(p.aliases ?? [])]) });
      setState("recording");
    } catch (e) {
      setProblem(String(e));
    }
  }
  async function stop(discard: boolean) {
    setState("finishing");
    try {
      const r = await invoke<Finished>("stop_recording", { discard, wav: discard ? null : wavPath() });
      if (!discard) onFinished(r);
    } catch (e) {
      setProblem(String(e));
    } finally {
      setState("idle");
      setLive({ committed: "", partial: "", seconds: 0 });
    }
  }

  return (
    <ModelGate>
      <div class="stack">
        <div class="row">
          {state === "idle" && <button class="primary" onClick={start}>● {label}</button>}
          {state === "recording" && <><span class="rec-dot" aria-hidden="true" /><span>Recording {mins(live.seconds)}</span><button onClick={async () => { await invoke("pause_recording"); setState("paused"); }}>Pause</button></>}
          {state === "paused" && <><span>Paused {mins(live.seconds)}</span><button onClick={async () => { await invoke("resume_recording"); setState("recording"); }}>Resume</button></>}
          {(state === "recording" || state === "paused") && <><button class="primary" onClick={() => stop(false)}>Done</button><button class="quiet" onClick={() => stop(true)}>Throw away</button></>}
          {state === "finishing" && <span class="muted">Finishing the transcript…</span>}
        </div>
        {state !== "idle" && (
          <div class="transcript" aria-live="polite">
            {live.committed}{live.committed && live.partial ? " " : ""}<span class="partial">{live.partial}</span>
            {!live.committed && !live.partial && <span class="muted">Start talking. The words appear here as you speak.</span>}
          </div>
        )}
        {problem && <p class="notice bad small" role="alert">{problem}</p>}
      </div>
    </ModelGate>
  );
}
