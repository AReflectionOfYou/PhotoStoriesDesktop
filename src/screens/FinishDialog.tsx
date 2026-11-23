// Wrapping up a session: what was worked on, a reminder that it's all saved,
// and the two things worth doing before stepping away: make an archive copy,
// and keep it somewhere safe.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "preact/hooks";
import { Dialog } from "../components/Dialog";
import { Thumb } from "../components/Thumb";
import { projectPhotos, type ProjectPhoto } from "../lib/photos";
import { useApp } from "../state";

export function FinishDialog({ onExport, onClose, onBackToPhotos }: { onExport(): void; onClose(): void; onBackToPhotos(): void }) {
  const app = useApp();
  const [photos, setPhotos] = useState<ProjectPhoto[] | null>(null);
  useEffect(() => {
    projectPhotos(app.root).then((all) => setPhotos(app.opened.map((id) => all.find((p) => p.id === id)).filter((p): p is ProjectPhoto => !!p)));
  }, []);
  const told = photos?.filter((p) => p.storied).length ?? 0;
  const collectionName = (id: string | null) => app.project.collections.find((c) => c.id === id)?.name ?? "";

  return (
    <Dialog title="Finishing for now" onClose={onClose}>
      <div class="stack">
        <p class="notice">Everything you saved is kept in this project's folder, <b>{app.root}</b>. Next time, open Photo Stories and pick up where you left off.</p>
        {photos && (photos.length ? (
          <>
            <h3>This session: {photos.length === 1 ? "1 photo" : `${photos.length} photos`}, {told === photos.length ? "all with stories" : `${told} with ${told === 1 ? "a story" : "stories"}`}</h3>
            <ul class="grid finish-grid">
              {photos.map((p) => (
                <li key={p.id} class="tile">
                  <Thumb file={`${app.root}/photos/${p.id}/thumb.jpg`} />
                  <span class="cap">{p.title}</span>
                  <span class={`small ${p.storied ? "saved" : "muted"}`}>{p.storied ? "✓ Story saved" : "No story yet"}</span>
                  {app.project.collections.length > 1 && <span class="small muted">{collectionName(p.collectionId)}</span>}
                </li>
              ))}
            </ul>
          </>
        ) : <p class="muted">No photos were opened this session.</p>)}
        <h3>Before you go</h3>
        <ul>
          <li><b>Make an archive copy.</b> Export makes one zip file with the photos, the stories and a page that shows them in any web browser.</li>
          <li><b>Keep it somewhere safe</b>, such as a USB drive, a cloud folder, or a copy for someone in the family.</li>
        </ul>
        <div class="row">
          <button class="primary" onClick={onExport}>Export an archive…</button>
          <button onClick={() => getCurrentWindow().close()}>Quit Photo Stories</button>
          <button class="quiet" onClick={onBackToPhotos}>Back to my photos</button>
          <button class="quiet" onClick={onClose}>Keep working</button>
        </div>
      </div>
    </Dialog>
  );
}
