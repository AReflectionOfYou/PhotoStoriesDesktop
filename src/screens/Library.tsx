// The main screen: photos in a folder of the person's choosing (left) and the
// photos already in the project (right). Choosing a photo copies it in and
// opens it.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "preact/hooks";
import { Thumb } from "../components/Thumb";
import { copyIntoProject, projectPhotos, type ProjectPhoto } from "../lib/photos";
import { useApp } from "../state";
import { pickFolder } from "./Welcome";

interface SourcePhoto { path: string; name: string; size: number; modified: number }

export function Library({ onOpen, onProblem }: { onOpen(id: string): void; onProblem(p: string): void }) {
  const app = useApp();
  const [source, setSource] = useState<{ photos: SourcePhoto[]; folders: string[] } | null>(null);
  const [mine, setMine] = useState<ProjectPhoto[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const folder = app.settings.sourceFolder;

  useEffect(() => {
    projectPhotos(app.root).then(setMine);
  }, [app.root]);
  useEffect(() => {
    if (!folder) return setSource(null);
    invoke<{ photos: SourcePhoto[]; folders: string[] }>("list_images", { dir: folder }).then(setSource, (e) => onProblem(String(e)));
  }, [folder]);

  const inProject = useMemo(() => new Map(mine.map((m) => [m.sourcePath, m.id])), [mine]);
  const shown = (source?.photos ?? []).filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()));

  async function choose(p: SourcePhoto) {
    const id = inProject.get(p.path);
    if (id) return onOpen(id);
    setBusy(p.path);
    try {
      const { doc } = await copyIntoProject(app.root, app.project, app.settings, p.path);
      onOpen(String(doc.photo.id));
    } catch (e) {
      onProblem(`Couldn't copy ${p.name}: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  const parent = folder && folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) || "/" : null;

  return (
    <div class="columns">
      <section class="panel source" aria-labelledby="src-h">
        <div class="spread">
          <h2 id="src-h">Your photos</h2>
          <button onClick={async () => { const f = await pickFolder("Choose a folder of photos"); if (f) await app.updateSettings({ sourceFolder: f }); }}>Choose folder…</button>
        </div>
        {!folder && <p class="muted">Choose a folder with the photos you want to tell stories about. They are only read, never changed.</p>}
        {folder && (
          <>
            <div class="row small">
              <span class="muted">{folder}</span>
              {parent && <button class="quiet" onClick={() => app.updateSettings({ sourceFolder: parent })}>Up one folder</button>}
            </div>
            {source && source.folders.length > 0 && (
              <div class="chips">
                {source.folders.map((f) => <button key={f} class="quiet small" onClick={() => app.updateSettings({ sourceFolder: f })}>📁 {f.split("/").pop()}</button>)}
              </div>
            )}
            {source && source.photos.length > 12 && <input type="search" placeholder="Find by file name" value={filter} onInput={(e) => setFilter(e.currentTarget.value)} aria-label="Find by file name" />}
            {source && !source.photos.length && <p class="muted">No photos in this folder.</p>}
            <ul class="grid">
              {shown.map((p) => (
                <li key={p.path}>
                  <button class={`tile ${inProject.has(p.path) ? "in-project" : ""}`} onClick={() => choose(p)} disabled={!!busy} aria-label={`${inProject.has(p.path) ? "Open" : "Add"} ${p.name}`}>
                    <Thumb source={p.path} />
                    <span class="cap">{busy === p.path ? "Copying…" : p.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section class="panel project" aria-labelledby="proj-h">
        <div class="spread"><h2 id="proj-h">In this project</h2><span class="muted small">{mine.length} photo{mine.length === 1 ? "" : "s"}, {mine.filter((m) => m.storied).length} with stories</span></div>
        {!mine.length && <p class="muted">Choose a photo on the left to copy it here and start its story.</p>}
        <ul class="grid">
          {mine.map((m) => (
            <li key={m.id}>
              <button class="tile" onClick={() => onOpen(m.id)} aria-label={`Open ${m.title}`}>
                <Thumb file={`${app.root}/photos/${m.id}/thumb.jpg`} />
                <span class="cap">{m.title}</span>
                {!m.storied && <span class="small muted">No story yet</span>}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
