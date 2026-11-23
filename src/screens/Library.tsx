// The main screen: the collection being worked on, photos in a folder of the
// person's choosing (left) and the photos already in the project (right).
// Choosing a photo copies it in and opens it; "Select several" picks a set of
// photos to work through one after another.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "preact/hooks";
import { Thumb } from "../components/Thumb";
import { copyIntoProject, projectPhotos, type ProjectPhoto } from "../lib/photos";
import { useApp } from "../state";
import { pickFolder } from "./Welcome";

interface SourcePhoto { path: string; name: string; size: number; modified: number }

export function Library({ onOpen, onProblem }: { onOpen(ids: string[], index?: number): void; onProblem(p: string): void }) {
  const app = useApp();
  const [source, setSource] = useState<{ photos: SourcePhoto[]; folders: string[] } | null>(null);
  const [mine, setMine] = useState<ProjectPhoto[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [picking, setPicking] = useState<"source" | "project" | null>(null);
  const [picked, setPicked] = useState<string[]>([]); // source paths or photo ids, in the order picked
  const [askCollection, setAskCollection] = useState<null | ((id: string | null) => void)>(null);
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
  const here = mine.filter((m) => !app.collectionId || m.collectionId === app.collectionId);
  const untold = here.filter((m) => !m.storied);

  /** The collection new photos go into: the one being worked on, or ask (null if they cancel). */
  const collectionFor = () => new Promise<string | null>((resolve) => (app.collectionId ? resolve(app.collectionId) : setAskCollection(() => resolve)));

  /** Copy photos in (those not already there) and return their ids, in order. */
  async function bringIn(paths: string[]): Promise<string[] | null> {
    const fresh = paths.filter((p) => !inProject.has(p));
    let collectionId: string | undefined;
    if (fresh.length) {
      const c = await collectionFor();
      if (!c) return null;
      collectionId = c;
    }
    const ids: string[] = [];
    try {
      for (const [i, path] of paths.entries()) {
        const existing = inProject.get(path);
        if (existing) { ids.push(existing); continue; }
        setBusy(paths.length > 1 ? `Copying ${i + 1} of ${paths.length}…` : path);
        const { doc } = await copyIntoProject(app.root, app.project, app.settings, path, collectionId);
        ids.push(String(doc.photo.id));
      }
      return ids;
    } catch (e) {
      onProblem(`Couldn't copy a photo: ${e}`);
      return null;
    } finally {
      setBusy(null);
    }
  }

  const togglePick = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  const stopPicking = () => { setPicking(null); setPicked([]); };

  async function startDeck() {
    if (!picked.length) return;
    const ids = picking === "source" ? await bringIn(picked) : picked;
    if (ids?.length) onOpen(ids, 0);
  }

  const parent = folder && folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) || "/" : null;

  return (
    <div class="stack">
      <CollectionBar counts={mine} />
      {askCollection && (
        <ChooseCollection
          onChosen={(id) => { app.setCollectionId(id); const go = askCollection; setAskCollection(null); go(id); }}
          onCancel={() => { const go = askCollection; setAskCollection(null); go(null); }}
        />
      )}
      <div class="columns">
        <section class="panel source" aria-labelledby="src-h">
          <div class="spread">
            <h2 id="src-h">Your photos</h2>
            <div class="row">
              {folder && source && source.photos.length > 1 && (picking === "source"
                ? <button class="quiet" onClick={stopPicking}>Cancel</button>
                : <button onClick={() => { setPicking("source"); setPicked([]); }}>Select several</button>)}
              <button onClick={async () => { const f = await pickFolder("Choose a folder of photos"); if (f) await app.updateSettings({ sourceFolder: f }); }}>Choose folder…</button>
            </div>
          </div>
          {!folder && <p class="muted">Choose a folder with the photos you want to tell stories about. They are only read, never changed.</p>}
          {folder && (
            <>
              <div class="row small">
                <span class="muted path">{folder}</span>
                {parent && <button class="quiet" onClick={() => app.updateSettings({ sourceFolder: parent })}>Up one folder</button>}
              </div>
              {source && source.folders.length > 0 && (
                <div class="chips">
                  {source.folders.map((f) => <button key={f} class="quiet small" onClick={() => app.updateSettings({ sourceFolder: f })}>📁 {f.split("/").pop()}</button>)}
                </div>
              )}
              {picking === "source" && <PickBar count={picked.length} busy={busy} onAll={() => setPicked(shown.map((p) => p.path))} onNone={() => setPicked([])} onStart={startDeck} />}
              {source && source.photos.length > 12 && <input type="search" placeholder="Find by file name" value={filter} onInput={(e) => setFilter(e.currentTarget.value)} aria-label="Find by file name" />}
              {source && !source.photos.length && <p class="muted">No photos in this folder.</p>}
              <ul class="grid">
                {shown.map((p) => {
                  const n = picked.indexOf(p.path);
                  return (
                    <li key={p.path}>
                      <button
                        class={`tile ${inProject.has(p.path) ? "in-project" : ""} ${n >= 0 ? "picked" : ""}`}
                        disabled={!!busy}
                        aria-pressed={picking === "source" ? n >= 0 : undefined}
                        aria-label={`${picking === "source" ? "Select" : inProject.has(p.path) ? "Open" : "Add"} ${p.name}`}
                        onClick={async () => {
                          if (picking === "source") return togglePick(p.path);
                          const ids = await bringIn([p.path]);
                          if (ids) onOpen(ids, 0);
                        }}
                      >
                        <Thumb source={p.path} />
                        {n >= 0 && <span class="pick-mark" aria-hidden="true">{n + 1}</span>}
                        <span class="cap">{busy === p.path ? "Copying…" : p.name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>

        <section class="panel project" aria-labelledby="proj-h">
          <div class="spread">
            <h2 id="proj-h">In this project</h2>
            {here.length > 1 && (picking === "project"
              ? <button class="quiet" onClick={stopPicking}>Cancel</button>
              : <button onClick={() => { setPicking("project"); setPicked([]); }}>Select several</button>)}
          </div>
          <div class="row small">
            <span class="muted">{here.length} photo{here.length === 1 ? "" : "s"}, {here.filter((m) => m.storied).length} with {here.filter((m) => m.storied).length === 1 ? "a story" : "stories"}</span>
            {untold.length > 0 && picking !== "project" && <button class="quiet small" onClick={() => onOpen(untold.map((m) => m.id), 0)}>Work through the {untold.length === 1 ? "one" : untold.length} without a story →</button>}
          </div>
          {picking === "project" && <PickBar count={picked.length} busy={busy} onAll={() => setPicked(here.map((m) => m.id))} onNone={() => setPicked([])} onStart={startDeck} />}
          {!here.length && <p class="muted">{mine.length ? "No photos in this collection yet. Choose photos on the left to add them." : "Choose a photo on the left to copy it here and start its story. Or use Select several to choose a set to work through."}</p>}
          <ul class="grid">
            {here.map((m, i) => {
              const n = picked.indexOf(m.id);
              return (
                <li key={m.id}>
                  <button class={`tile ${n >= 0 ? "picked" : ""}`} aria-pressed={picking === "project" ? n >= 0 : undefined} aria-label={`${picking === "project" ? "Select" : "Open"} ${m.title}`}
                    onClick={() => (picking === "project" ? togglePick(m.id) : onOpen(here.map((x) => x.id), i))}>
                    <Thumb file={`${app.root}/photos/${m.id}/thumb.jpg`} />
                    {n >= 0 && <span class="pick-mark" aria-hidden="true">{n + 1}</span>}
                    <span class="cap">{m.title}</span>
                    {!m.storied && <span class="small muted">No story yet</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}

function PickBar({ count, busy, onAll, onNone, onStart }: { count: number; busy: string | null; onAll(): void; onNone(): void; onStart(): void }) {
  return (
    <div class="pickbar stack">
      <span class="small"><b>{count}</b> selected. Click photos to add them to the set, in the order you want to go through them.</span>
      <div class="row">
        <button class="primary" disabled={!count || !!busy} onClick={onStart}>{busy && busy.startsWith("Copying") ? busy : count === 1 ? "Start with this photo →" : `Start with these ${count || ""} photos →`}</button>
        <button class="quiet small" onClick={onAll}>Select all</button>
        {count > 0 && <button class="quiet small" onClick={onNone}>Clear</button>}
      </div>
    </div>
  );
}

/** Which collection is being worked on (new photos go into it), and managing collections. */
function CollectionBar({ counts }: { counts: ProjectPhoto[] }) {
  const app = useApp();
  const [mode, setMode] = useState<"new" | "rename" | null>(null);
  const [name, setName] = useState("");
  const cols = app.project.collections;
  const current = cols.find((c) => c.id === app.collectionId);
  const count = (id: unknown) => counts.filter((p) => p.collectionId === id).length;

  async function submit() {
    const n = name.trim();
    if (!n) return;
    if (mode === "new") app.setCollectionId(await app.addCollection(n));
    else if (mode === "rename" && current) {
      current.name = n;
      await app.saveProjectData(["collections"]);
    }
    setMode(null);
    setName("");
  }

  async function remove() {
    if (!current || count(current.id) || cols.length < 2) return;
    app.project.collections.splice(cols.indexOf(current), 1);
    app.setCollectionId(app.project.collections.length === 1 ? String(app.project.collections[0].id) : null);
    await app.saveProjectData(["collections"]);
  }

  return (
    <div class="collection-bar">
      <div class="row">
        <label class="inline">
          <span>Collection</span>
          <select value={app.collectionId ?? ""} onChange={(e) => app.setCollectionId(e.currentTarget.value || null)} aria-describedby="col-help">
            {cols.length > 1 && <option value="">All collections ({counts.length})</option>}
            {cols.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.name)} ({count(c.id)})</option>)}
          </select>
        </label>
        {mode ? (
          <span class="row">
            <input type="text" autocomplete="off" value={name} placeholder={mode === "new" ? "Name, e.g. Lake cabin album" : "New name"} aria-label={mode === "new" ? "New collection name" : "Collection name"}
              onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setMode(null); }} ref={(el) => el?.focus()} style="width:16rem" />
            <button class="small" onClick={submit} disabled={!name.trim()}>{mode === "new" ? "Add" : "Rename"}</button>
            <button class="quiet small" onClick={() => setMode(null)}>Cancel</button>
          </span>
        ) : (
          <span class="row">
            <button class="quiet small" onClick={() => { setMode("new"); setName(""); }}>New collection</button>
            {current && <button class="quiet small" onClick={() => { setMode("rename"); setName(String(current.name)); }}>Rename</button>}
            {current && cols.length > 1 && !count(current.id) && <button class="quiet small" onClick={remove}>Delete this empty collection</button>}
          </span>
        )}
      </div>
      <p id="col-help" class="small muted">
        {current ? <>New photos go into <b>{String(current.name)}</b>. A collection can be an album, a box of prints, a trip, or one person's photos.</> : "Showing every collection. When you add photos, you'll be asked which collection they go into."}
      </p>
    </div>
  );
}

/** Asked when adding photos while "All collections" is shown. */
function ChooseCollection({ onChosen, onCancel }: { onChosen(id: string): void; onCancel(): void }) {
  const app = useApp();
  const [name, setName] = useState("");
  return (
    <div class="notice stack" role="alertdialog" aria-labelledby="choose-col-h">
      <strong id="choose-col-h">Which collection should these photos go into?</strong>
      <div class="row">
        {app.project.collections.map((c) => <button key={String(c.id)} onClick={() => onChosen(String(c.id))}>{String(c.name)}</button>)}
      </div>
      <div class="row">
        <input type="text" autocomplete="off" value={name} placeholder="Or a new collection" aria-label="New collection name" style="width:16rem" onInput={(e) => setName(e.currentTarget.value)} />
        <button disabled={!name.trim()} onClick={async () => onChosen(await app.addCollection(name))}>Add and use it</button>
        <button class="quiet" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
