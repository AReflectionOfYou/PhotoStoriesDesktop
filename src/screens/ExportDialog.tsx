// Export: one validated BagIt zip with the photos, their stories, thumbnails,
// a readme, and START HERE.html (made by photostories-core).

import { useEffect, useState } from "preact/hooks";
import { exportBundle, type ExportResult } from "photostories-core";
import { Dialog } from "../components/Dialog";
import { Thumb } from "../components/Thumb";
import { reveal } from "../lib/open";
import { projectPhotos, type ProjectPhoto } from "../lib/photos";
import { fs } from "../lib/tauri-adapter";
import { APP, useApp } from "../state";
import { pickFolder } from "./Welcome";

export function ExportDialog({ onClose }: { onClose(): void }) {
  const app = useApp();
  const [photos, setPhotos] = useState<ProjectPhoto[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [which, setWhich] = useState<"storied" | "collection" | "chosen">("storied");
  const [collection, setCollection] = useState<string>(app.collectionId ?? String(app.project.collections[0]?.id ?? ""));
  const [dest, setDest] = useState(`${app.root}/exports`);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    projectPhotos(app.root).then((p) => {
      setPhotos(p);
      setChosen(new Set(p.filter((x) => x.storied).map((x) => x.id)));
    });
  }, []);
  const storied = photos.filter((p) => p.storied);
  const inCollection = storied.filter((p) => p.collectionId === collection);
  const several = app.project.collections.length > 1;

  async function run() {
    setBusy(true);
    setProblem("");
    try {
      const r = await exportBundle(fs, app.root, dest, { photoIds: which === "chosen" ? [...chosen] : which === "collection" ? inCollection.map((p) => p.id) : undefined, generator: APP });
      setResult(r);
    } catch (e) {
      setProblem(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Export an archive" onClose={onClose}>
      {result ? (
        result.problems.length ? (
          <div class="notice bad stack" role="alert"><p>The archive didn't pass its own check, so it wasn't zipped. Nothing was lost; please try again. Details:</p><ul>{result.problems.slice(0, 10).map((p) => <li key={p} class="small">{p}</li>)}</ul></div>
        ) : (
          <div class="stack">
            <p class="notice">Done. The archive holds {result.counts.photos === 1 ? "1 photo with its story" : `${result.counts.photos} photos with their stories`}, and it passed its checksum check.</p>
            <p class="small">{result.zipPath}</p>
            <p class="small muted">To look through it, unzip it and double-click <b>START HERE.html</b>. It works on any computer, without internet. Keep copies somewhere safe.</p>
            <div class="row"><button class="primary" onClick={() => reveal(result.zipPath)}>Show in folder</button><button onClick={onClose}>Close</button></div>
          </div>
        )
      ) : (
        <div class="stack">
          <p>An archive is a single zip file following the Library of Congress BagIt standard. It holds your copies of the photos, everything you recorded about them, and a page that shows them all in any web browser.</p>
          <label class="inline"><input type="radio" name="which" checked={which === "storied"} onChange={() => setWhich("storied")} /> Every photo with a story ({storied.length})</label>
          {several && (
            <label class="inline"><input type="radio" name="which" checked={which === "collection"} onChange={() => setWhich("collection")} /> Every photo with a story in
              <select value={collection} onChange={(e) => { setCollection(e.currentTarget.value); setWhich("collection"); }} aria-label="Collection" style="width:auto">
                {app.project.collections.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.name)}</option>)}
              </select> ({inCollection.length})</label>
          )}
          <label class="inline"><input type="radio" name="which" checked={which === "chosen"} onChange={() => setWhich("chosen")} /> Only the ones I choose ({chosen.size})</label>
          {which === "chosen" && (
            <ul class="grid" style="max-height: 40vh; overflow: auto;">
              {photos.map((p) => (
                <li key={p.id}>
                  <label class="tile" style="font-weight:400">
                    <Thumb file={`${app.root}/photos/${p.id}/thumb.jpg`} />
                    <span class="row small"><input type="checkbox" checked={chosen.has(p.id)} onChange={(e) => { const s = new Set(chosen); e.currentTarget.checked ? s.add(p.id) : s.delete(p.id); setChosen(s); }} />{p.title}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div class="spread"><span class="small">Save to: {dest}</span><button onClick={async () => { const f = await pickFolder("Where should the archive go?"); if (f) setDest(f); }}>Change…</button></div>
          {problem && <p class="notice bad" role="alert">{problem}</p>}
          <div class="row"><button class="primary" disabled={busy || (which === "storied" ? !storied.length : which === "collection" ? !inCollection.length : !chosen.size)} onClick={run}>{busy ? "Making the archive…" : "Export"}</button><button class="quiet" onClick={onClose}>Cancel</button></div>
        </div>
      )}
    </Dialog>
  );
}
