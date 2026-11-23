import { useEffect, useMemo, useState } from "preact/hooks";
import { loadProject, saveProject, type ProjectData } from "photostories-core";
import { Footer } from "./components/Footer";
import { fs } from "./lib/tauri-adapter";
import { loadSettings, saveSettings, type Settings } from "./lib/settings";
import { Editor } from "./screens/Editor";
import { ExportDialog } from "./screens/ExportDialog";
import { ImportDialog } from "./screens/ImportDialog";
import { Library } from "./screens/Library";
import { SettingsDialog } from "./screens/Settings";
import { Welcome } from "./screens/Welcome";
import { Ctx, type AppState } from "./state";

type Dialog = "export" | "import" | "settings" | null;

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [project, setProject] = useState<ProjectData | null>(null);
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [problem, setProblem] = useState("");
  const [version, setVersion] = useState(0);

  useEffect(() => {
    loadSettings().then(async (s) => {
      setSettings(s);
      if (s.projectRoot && (await fs.exists(`${s.projectRoot}/group.json`))) setProject(await loadProject(fs, s.projectRoot));
    });
  }, []);

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
    };
  }, [settings, project]);

  if (!settings) return <div class="content muted">Opening…</div>;

  if (!state) {
    return (
      <div class="shell">
        <header class="topbar"><div class="title"><h1>Photo Stories</h1></div></header>
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

  return (
    <Ctx.Provider value={state}>
      <div class="shell">
        <header class="topbar">
          <div class="title">
            <h1>{String(state.project.group.name)}</h1>
            <span class="muted small">{state.root}</span>
          </div>
          <nav class="row" aria-label="Project">
            <button onClick={() => setDialog("import")}>Import</button>
            <button onClick={() => setDialog("export")}>Export</button>
            <button onClick={() => setDialog("settings")}>Settings</button>
            <button class="quiet" onClick={async () => { await state.updateSettings({ projectRoot: null }); setProject(null); setPhotoId(null); }}>Switch project</button>
          </nav>
        </header>
        <main class="content">
          {problem && <p class="notice bad" role="alert">{problem} <button class="quiet" onClick={() => setProblem("")}>Dismiss</button></p>}
          {photoId ? (
            <Editor key={photoId} photoId={photoId} onClose={() => { setPhotoId(null); setVersion((v) => v + 1); }} />
          ) : (
            <Library key={version} onOpen={setPhotoId} onProblem={setProblem} />
          )}
        </main>
        <Footer />
      </div>
      {dialog === "export" && <ExportDialog onClose={() => setDialog(null)} />}
      {dialog === "import" && <ImportDialog onClose={async () => { setDialog(null); await state.reloadProject(); }} />}
      {dialog === "settings" && <SettingsDialog onClose={() => setDialog(null)} />}
    </Ctx.Provider>
  );
}
