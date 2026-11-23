// Settings: the project's owner and license, the speech model, how photos are
// copied, and the optional cloud cleanup with the person's own API key.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "preact/hooks";
import { Dialog } from "../components/Dialog";
import { useModel } from "../components/Recorder";
import type { Provider } from "../lib/settings";
import { useApp } from "../state";
import { LICENSES } from "./Welcome";

export function SettingsDialog({ onClose }: { onClose(): void }) {
  const app = useApp();
  const s = app.settings;
  const g = app.project.group;
  const [owner, setOwner] = useState(String(g.owner_name ?? ""));
  const [contact, setContact] = useState(String(g.owner_contact ?? ""));
  const [rights, setRights] = useState(String(g.rights ?? LICENSES[0]));
  const [role, setRole] = useState(String(g.owner_role ?? "creator"));
  const [name, setName] = useState(String(g.name ?? ""));
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState("");
  const model = useModel();

  useEffect(() => {
    for (const p of ["anthropic", "openai"]) invoke<string | null>("get_api_key", { provider: p }).then((k) => setHasKey((h) => ({ ...h, [p]: !!k })), () => {});
  }, []);

  async function saveProjectDetails() {
    Object.assign(g, { name: name.trim() || g.name, owner_name: owner.trim(), owner_contact: contact.trim() || null, rights, owner_role: role });
    const me = app.project.contributors.find((c) => c.id === g.owner_contributor_id);
    if (me && owner.trim()) me.display_name = owner.trim();
    await app.saveProjectData(["group", "contributors"]);
    setNote("Saved. New saves and exports use these details.");
  }

  async function saveKey() {
    await invoke("set_api_key", { provider: s.provider, key });
    setKey("");
    setHasKey({ ...hasKey, [s.provider]: true });
    setNote("The key is stored in this computer's keychain.");
  }

  return (
    <Dialog title="Settings" onClose={onClose}>
      <section class="card stack">
        <h3>This project</h3>
        <label>Project name<input type="text" value={name} onInput={(e) => setName(e.currentTarget.value)} /></label>
        <label>Your name<input type="text" value={owner} onInput={(e) => setOwner(e.currentTarget.value)} /></label>
        <label>Contact (recorded in exports)<input type="email" value={contact} onInput={(e) => setContact(e.currentTarget.value)} /></label>
        <label>License for your photos and stories (Dublin Core “rights”)<select value={rights} onChange={(e) => setRights(e.currentTarget.value)}>{[...new Set([...LICENSES, rights])].map((l) => <option key={l}>{l}</option>)}</select></label>
        <label>In archive records, you are the photos'<select value={role} onChange={(e) => setRole(e.currentTarget.value)}><option value="creator">creator</option><option value="contributor">contributor (someone else took them)</option></select></label>
        <div><button onClick={saveProjectDetails}>Save project details</button></div>
      </section>

      <section class="card stack">
        <h3>Speech to text</h3>
        <label>Speech model<select value={s.model} onChange={(e) => app.updateSettings({ model: e.currentTarget.value as "small" | "medium" })}>
          <option value="small">Small: fast, good for clear speech (about 490 MB)</option>
          <option value="medium">Medium: slower, better for difficult audio (about 1.5 GB)</option>
        </select></label>
        <p class="small muted">{model.status?.present ? "Downloaded and ready. Works without internet." : "Not downloaded yet. It downloads the first time you record, or now:"}</p>
        {model.status && !model.status.present && (model.progress === null ? <div><button onClick={model.download}>Download now</button></div> : <div class="progress"><div style={`width:${model.progress * 100}%`} /></div>)}
        <label class="inline"><input type="checkbox" checked={s.keepRecordings} onChange={(e) => app.updateSettings({ keepRecordings: e.currentTarget.checked })} /> Keep the recordings with the photos (they're included in exports and can be played in the archive)</label>
      </section>

      <section class="card stack">
        <h3>Copying photos</h3>
        <label class="inline"><input type="radio" name="size" checked={s.copySize === "full"} onChange={() => app.updateSettings({ copySize: "full" })} /> Full size (an exact copy)</label>
        <label class="inline"><input type="radio" name="size" checked={s.copySize === "resized"} onChange={() => app.updateSettings({ copySize: "resized" })} /> Smaller copies, at most <input type="number" min={800} max={10000} step={100} style="width:6rem" value={s.maxLongEdge} onChange={(e) => app.updateSettings({ maxLongEdge: Math.max(800, +e.currentTarget.value || 3000) })} /> pixels on the long side</label>
        <label class="inline"><input type="checkbox" checked={s.embedStory} onChange={(e) => app.updateSettings({ embedStory: e.currentTarget.checked })} /> Write the story inside the copy's photo file too, so it travels with the photo</label>
        <label class="inline"><input type="checkbox" checked={s.lookUpPlaces} onChange={(e) => app.updateSettings({ lookUpPlaces: e.currentTarget.checked })} /> When a photo has map coordinates, look up the place name for Where (sends only the coordinates to OpenStreetMap)</label>
      </section>

      <section class="card stack">
        <h3>Story cleanup</h3>
        <p class="small muted">Without a key, a light cleanup on this computer keeps your own words. With your own API key, an online service tidies the story and suggests a title, people, place and date. You review everything before saving.</p>
        <label>Cleanup<select value={s.provider} onChange={(e) => app.updateSettings({ provider: e.currentTarget.value as Provider })}>
          <option value="none">On this computer (no key needed)</option>
          <option value="anthropic">Anthropic (Claude), with my API key</option>
          <option value="openai">OpenAI, with my API key</option>
        </select></label>
        {s.provider !== "none" && (
          <>
            <label>Model<input type="text" value={s.provider === "anthropic" ? s.anthropicModel : s.openaiModel} onChange={(e) => app.updateSettings(s.provider === "anthropic" ? { anthropicModel: e.currentTarget.value.trim() } : { openaiModel: e.currentTarget.value.trim() })} /></label>
            <div class="row" style="align-items:end">
              <label style="flex:1">API key {hasKey[s.provider] ? "(one is saved)" : ""}<input type="password" value={key} autocomplete="off" placeholder={hasKey[s.provider] ? "Paste a new key to replace it" : "Paste your key"} onInput={(e) => setKey(e.currentTarget.value)} /></label>
              <button disabled={!key.trim()} onClick={saveKey}>Save key</button>
              {hasKey[s.provider] && <button class="quiet" onClick={async () => { await invoke("delete_api_key", { provider: s.provider }); setHasKey({ ...hasKey, [s.provider]: false }); }}>Remove key</button>}
            </div>
            <p class="small muted">Only the transcript text is sent for cleanup, never the photo. The key stays in this computer's keychain.</p>
          </>
        )}
      </section>
      {note && <p class="notice small" role="status">{note}</p>}
      <div><button class="primary" onClick={onClose}>Done</button></div>
    </Dialog>
  );
}
