import { useEffect, useMemo, useState } from "preact/hooks";
import { loadProject, saveProject, uuid, type ProjectData } from "photostories-core";
import { Footer } from "./components/Footer";
import { ModelNote } from "./components/ModelNote";
import { fs } from "./lib/tauri-adapter";
import { ensureModel } from "./lib/model";
import { loadSettings, saveSettings, type Settings } from "./lib/settings";
import { Editor } from "./screens/Editor";
import { ExportDialog } from "./screens/ExportDialog";
import { FinishDialog } from "./screens/FinishDialog";
import { ImportDialog } from "./screens/ImportDialog";
import { Library } from "./screens/Library";
import { SettingsDialog } from "./screens/Settings";
import { Welcome } from "./screens/Welcome";
import { Ctx, openPhoto, type AppState } from "./state";

type Dialog = "export" | "import" | "settings" | "finish" | null;
/** The photos being worked through, and which one is open. */
type Deck = { ids: string[]; index: number };

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [project, setProject] = useState<ProjectData | null>(null);
  const [deck, setDeck] = useState<Deck | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [problem, setProblem] = useState("");
  const [version, setVersion] = useState(0);
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [tipsOpen, setTipsOpen] = useState(false);
  const [opened, setOpened] = useState<string[]>([]);

  useEffect(() => {
    loadSettings().then(async (s) => {
      setSettings(s);
      // Fetch the speech model in the background while the person gets started.
      // If there's no internet now, it's offered again when they first record.
      ensureModel(s.model).catch(() => {});
      if (s.projectRoot && (await fs.exists(`${s.projectRoot}/group.json`))) setProject(await loadProject(fs, s.projectRoot));
    });
  }, []);

  // A new session in a project: with one collection, that's the one; with
  // several, the person chooses (it is never assumed).
  useEffect(() => {
    setCollectionId(project && project.collections.length === 1 ? String(project.collections[0].id) : null);
    setOpened([]);
  }, [project?.group.id]);

  const photoId = deck ? deck.ids[deck.index] : null;
  useEffect(() => {
    if (photoId) setOpened((o) => (o.includes(photoId) ? o : [...o, photoId]));
  }, [photoId]);

  const state = useMemo<AppState | null>(() => {
    if (!settings || !project || !settings.projectRoot) return null;
    const root = settings.projectRoot;
    return {
      settings,
      async updateSettings(patch) {
        const next = { ...settings, ...patch };
        setSettings(next);
        await saveSettings(next);
      },
      root,
      project,
      async reloadProject() {
        setProject(await loadProject(fs, root));
        setVersion((v) => v + 1);
      },
      async saveProjectData(keys) {
        await saveProject(fs, root, project, keys);
        setProject({ ...project });
      },
      owner: String(project.group.owner_contributor_id ?? project.contributors[0]?.id ?? ""),
      collectionId,
      setCollectionId,
      async addCollection(name) {
        const owner = String(project.group.owner_contributor_id ?? project.contributors[0]?.id ?? "");
        const c = { id: uuid(), group_id: project.group.id, name: name.trim(), description: null, created_by: owner || null, created_at: new Date().toISOString() };
        project.collections.push(c);
        await saveProject(fs, root, project, ["collections"]);
        setProject({ ...project });
        return c.id;
      },
      tipsOpen,
      setTipsOpen,
      opened,
    };
  }, [settings, project, collectionId, tipsOpen, opened]);

  if (!settings) return <div class="content muted">Opening…</div>;

  if (!state) {
    return (
      <div class="shell">
        <header class="topbar"><div class="title"><h1>Photo Stories</h1></div><ModelNote model={settings.model} /></header>
        <main class="content">
          <Welcome
            settings={settings}
            onOpen={async (root, data) => {
              const next = { ...settings, projectRoot: root, recentProjects: [root, ...settings.recentProjects.filter((r) => r !== root)].slice(0, 8) };
              await saveSettings(next);
              setSettings(next);
              setProject(data);
            }}
          />
        </main>
        <Footer />
      </div>
    );
  }

  /** Save the open photo first, if it has changes; false if the person cancelled. */
  const savedFirst = async () => !openPhoto.dirty || (await openPhoto.save());
  const backToPhotos = () => { setDeck(null); setVersion((v) => v + 1); };

  return (
    <Ctx.Provider value={state}>
      <div class="shell">
        <header class="topbar">
          <div class="title">
            <h1>{String(state.project.group.name)}</h1>
            <span class="muted small">{state.root}</span>
          </div>
          <nav class="row" aria-label="Project">
            <ModelNote model={state.settings.model} />
            <button onClick={() => setDialog("import")}>Import</button>
            <button onClick={() => setDialog("export")}>Export</button>
            <button onClick={() => setDialog("settings")}>Settings</button>
            <button onClick={async () => { if (await savedFirst()) setDialog("finish"); }}>Finish</button>
            <button class="quiet" onClick={async () => { if (!(await savedFirst())) return; await state.updateSettings({ projectRoot: null }); setProject(null); setDeck(null); }}>Switch project</button>
          </nav>
        </header>
        <main class="content">
          {problem && <p class="notice bad" role="alert">{problem} <button class="quiet" onClick={() => setProblem("")}>Dismiss</button></p>}
          {deck && photoId ? (
            <Editor
              key={photoId}
              photoId={photoId}
              deck={deck.ids}
              index={deck.index}
              onGo={(index) => setDeck({ ...deck, index })}
              onClose={backToPhotos}
            />
          ) : (
            <Library key={version} onOpen={(ids, index = 0) => setDeck({ ids, index })} onProblem={setProblem} />
          )}
        </main>
        <Footer />
      </div>
      {dialog === "export" && <ExportDialog onClose={() => setDialog(null)} />}
      {dialog === "import" && <ImportDialog onClose={async () => { setDialog(null); await state.reloadProject(); }} />}
      {dialog === "settings" && <SettingsDialog onClose={() => setDialog(null)} />}
      {dialog === "finish" && <FinishDialog onExport={() => setDialog("export")} onClose={() => setDialog(null)} onBackToPhotos={() => { setDialog(null); backToPhotos(); }} />}
    </Ctx.Provider>
  );
}
