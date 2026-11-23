// First run: choose or create a project folder. Everything the app makes
// (copied photos, sidecars, exports) lives under it.

import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "preact/hooks";
import { createProject, loadProject, type ProjectData } from "photostories-core";
import { normalizePath } from "../lib/image";
import type { Settings } from "../lib/settings";
import { fs } from "../lib/tauri-adapter";

export const LICENSES = ["All rights reserved", "CC BY 4.0", "CC BY-NC 4.0", "CC BY-SA 4.0", "CC0 1.0 (public domain)"];

export function Welcome({ settings, onOpen }: { settings: Settings; onOpen(root: string, data: ProjectData): void }) {
  const [folder, setFolder] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [contact, setContact] = useState("");
  const [rights, setRights] = useState(LICENSES[0]);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);

  async function openExisting(path?: string) {
    setProblem("");
    const root = path ?? (await pickFolder("Open a Photo Stories project folder"));
    if (!root) return;
    if (!(await fs.exists(`${root}/group.json`))) {
      setProblem("That folder isn't a Photo Stories project. To start one there, use “Start a new project” below.");
      return;
    }
    onOpen(root, await loadProject(fs, root));
  }

  async function start(e: Event) {
    e.preventDefault();
    if (!folder) return;
    setBusy(true);
    setProblem("");
    try {
      if (await fs.exists(`${folder}/group.json`)) return openExisting(folder);
      const entries = await fs.list(folder);
      const root = entries.length ? `${folder}/${name.trim().replace(/[\\/:*?"<>|]+/g, "-") || "Photo Stories"}` : folder;
      const data = await createProject(fs, root, { name: name.trim(), ownerName: owner.trim(), ownerContact: contact.trim() || undefined, rights });
      onOpen(root, data);
    } catch (err) {
      setProblem(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="stack" style="max-width: 44rem; margin: 0 auto;">
      <section class="card stack">
        <h2>Welcome to Photo Stories</h2>
        <p>Pick a few special photos, tell the story behind each one in your own words, and name the people in them. Photo Stories keeps a copy of each photo with its story, and can save everything as a permanent archive you can open in any web browser.</p>
        <p class="muted">Your own photos are never changed or moved. Everything works on this computer, with no account and no internet.</p>
      </section>

      {settings.recentProjects.length > 0 && (
        <section class="card stack">
          <h3>Recent projects</h3>
          {settings.recentProjects.map((r) => (
            <div class="spread" key={r}><span>{r}</span><button onClick={() => openExisting(r)}>Open</button></div>
          ))}
        </section>
      )}

      <section class="card stack">
        <div class="spread"><h3>Open a project</h3><button onClick={() => openExisting()}>Choose folder…</button></div>
      </section>

      <form class="card stack" onSubmit={start}>
        <h3>Start a new project</h3>
        <label>Project name<input type="text" required value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder="Grandma Rose's photos" /></label>
        <label>Your name (the storyteller)<input type="text" required value={owner} onInput={(e) => setOwner(e.currentTarget.value)} /></label>
        <label>Contact (optional, recorded in exports)<input type="email" value={contact} onInput={(e) => setContact(e.currentTarget.value)} placeholder="you@example.com" /></label>
        <label>License for your photos and stories<select value={rights} onChange={(e) => setRights(e.currentTarget.value)}>{LICENSES.map((l) => <option key={l}>{l}</option>)}</select></label>
        <div class="spread">
          <span class="muted small">{folder ? `Folder: ${folder}` : "Choose where the project lives (an empty folder, or one to put it in)."}</span>
          <button type="button" onClick={async () => setFolder(await pickFolder("Where should the project live?"))}>Choose folder…</button>
        </div>
        <div><button class="primary" disabled={!folder || busy}>Start project</button></div>
      </form>
      {problem && <p class="notice bad" role="alert">{problem}</p>}
    </div>
  );
}

export async function pickFolder(title: string): Promise<string | null> {
  const r = await open({ directory: true, multiple: false, title });
  return typeof r === "string" ? normalizePath(r) : null;
}
