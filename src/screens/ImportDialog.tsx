// Import: bring in an archive made earlier (by this app or any Photo Stories),
// to restore a collection, move it to a new computer, or combine collections.
// Nothing is written until the person confirms.

import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "preact/hooks";
import { commitImport, discardImport, planImport, type DuplicateChoice, type ImportPlan, type ImportSummary } from "photostories-core";
import { Dialog } from "../components/Dialog";
import { normalizePath } from "../lib/image";
import { fs } from "../lib/tauri-adapter";
import { useApp } from "../state";
import { pickFolder } from "./Welcome";

const CHOICE: Record<DuplicateChoice, string> = { skip: "Skip it", replace: "Replace mine", keepBoth: "Keep both" };

export function ImportDialog({ onClose }: { onClose(): void }) {
  const app = useApp();
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  const [dups, setDups] = useState<Record<string, DuplicateChoice>>({});
  const [all, setAll] = useState<DuplicateChoice>("skip");
  const [names, setNames] = useState<Record<string, string>>({});
  const [continueAnyway, setContinueAnyway] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  async function choose(kind: "zip" | "folder") {
    setProblem("");
    const path = kind === "zip" ? await open({ multiple: false, title: "Choose a Photo Stories archive", filters: [{ name: "Photo Stories archive", extensions: ["zip"] }] }) : await pickFolder("Choose an unzipped Photo Stories archive");
    if (typeof path !== "string") return;
    setBusy("Checking the archive…");
    try {
      const p = await planImport(fs, normalizePath(path), app.root);
      setPlan(p);
      setNames(Object.fromEntries(p.names.filter((n) => n.status === "review").map((n) => [String(n.incoming.id), String(n.matches[0].person.id)])));
    } catch (e) {
      setProblem(`That doesn't look like a Photo Stories archive: ${e}`);
    } finally {
      setBusy("");
    }
  }

  async function cancel() {
    if (plan) await discardImport(fs, plan);
    onClose();
  }

  async function go() {
    if (!plan) return;
    setBusy("Importing…");
    try {
      setSummary(await commitImport(fs, plan, { duplicates: dups, allDuplicates: all, names, includeDamaged: false, by: app.owner }));
    } catch (e) {
      setProblem(String(e));
    } finally {
      setBusy("");
    }
  }

  if (summary) {
    const line = (n: number, one: string, many: string) => (n ? <li>{n} {n === 1 ? one : many}</li> : null);
    return (
      <Dialog title="Import finished" onClose={onClose}>
        <ul>
          {line(summary.added.length, "new photo added", "new photos added")}
          {line(summary.replaced.length, "photo replaced", "photos replaced")}
          {line(summary.keptBoth.length, "duplicate kept as a separate copy", "duplicates kept as separate copies")}
          {line(summary.skipped.length, "duplicate skipped", "duplicates skipped")}
          {line(summary.damagedSkipped.length, "damaged photo left out", "damaged photos left out")}
          {line(summary.peopleAdded.length, `new name (${summary.peopleAdded.join(", ")})`, `new names (${summary.peopleAdded.join(", ")})`)}
          {summary.peopleMerged.map((m) => <li key={m.from}>“{m.from}” merged into “{m.into}”</li>)}
        </ul>
        {summary.newerSchema.length > 0 && <p class="notice small">{summary.newerSchema.length} photo(s) came from a newer version of Photo Stories. Everything this version understands was imported; the rest was kept as it was.</p>}
        <div><button class="primary" onClick={onClose}>Done</button></div>
      </Dialog>
    );
  }

  if (!plan) {
    return (
      <Dialog title="Import an archive" onClose={onClose}>
        <p>Bring in an archive exported earlier, from this computer or another, or from the shared online Photo Stories. You'll see what's new before anything is added. The archive itself isn't changed.</p>
        <div class="row"><button class="primary" disabled={!!busy} onClick={() => choose("zip")}>Choose a .zip archive…</button><button disabled={!!busy} onClick={() => choose("folder")}>Choose an unzipped folder…</button></div>
        {busy && <p class="muted" role="status">{busy}</p>}
        {problem && <p class="notice bad" role="alert">{problem}</p>}
      </Dialog>
    );
  }

  const p = plan.preview;
  const duplicates = plan.photos.filter((x) => x.status === "duplicate");
  const review = plan.names.filter((n) => n.status === "review");
  const damaged = plan.photos.filter((x) => x.status === "damaged");
  const blocked = plan.problems.length > 0 && !continueAnyway;

  return (
    <Dialog title="Before importing" onClose={cancel}>
      <ul>
        <li>{p.photos === 1 ? "1 photo" : `${p.photos} photos`} in the archive: <b>{p.new} new</b>{p.duplicates ? `, ${p.duplicates} already here` : ""}{p.damaged ? `, ${p.damaged} damaged` : ""}.</li>
        <li>{p.newNames === 1 ? "1 new name" : `${p.newNames} new names`}{p.namesToReview ? `, ${p.namesToReview} to check` : ""}{p.sameNames ? `, ${p.sameNames} already known` : ""}.</li>
        {p.olderSchema > 0 && <li class="small muted">{p.olderSchema} photos were made by an earlier version and will be upgraded as they come in.</li>}
        {p.newerSchema > 0 && <li class="small">{p.newerSchema} photos come from a newer version of Photo Stories; what this version understands will be imported.</li>}
      </ul>

      {plan.problems.length > 0 && (
        <div class="notice bad stack" role="alert">
          <p>Some files in this archive are missing or damaged (their checksums don't match):</p>
          <ul class="small">{plan.problems.slice(0, 8).map((x) => <li key={x}>{x}</li>)}{plan.problems.length > 8 && <li>…and {plan.problems.length - 8} more</li>}</ul>
          {damaged.length > 0 && <p class="small">Affected photos, which will be left out: {damaged.map((d) => d.title).join(", ")}.</p>}
          <label class="inline"><input type="checkbox" checked={continueAnyway} onChange={(e) => setContinueAnyway(e.currentTarget.checked)} /> Continue with the files that are fine</label>
        </div>
      )}

      {duplicates.length > 0 && (
        <section class="stack">
          <div class="spread"><h3>Already in this project</h3>
            {duplicates.length > 1 && <label class="inline small">For all of them: <select value={all} onChange={(e) => { const v = e.currentTarget.value as DuplicateChoice; setAll(v); setDups({}); }}>{Object.entries(CHOICE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>}
          </div>
          <table class="list"><tbody>
            {duplicates.map((d) => (
              <tr key={d.id}><td>{d.title}</td><td>
                <select aria-label={`What to do with ${d.title}`} value={dups[d.id] ?? all} onChange={(e) => setDups({ ...dups, [d.id]: e.currentTarget.value as DuplicateChoice })}>{Object.entries(CHOICE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              </td></tr>
            ))}
          </tbody></table>
        </section>
      )}

      {review.length > 0 && (
        <section class="stack">
          <h3>Are these the same people?</h3>
          <table class="list"><tbody>
            {review.map((n) => (
              <tr key={String(n.incoming.id)}>
                <td>“{String(n.incoming.display_name)}”</td>
                <td>
                  <select aria-label={`Who is ${n.incoming.display_name}`} value={names[String(n.incoming.id)] ?? "separate"} onChange={(e) => setNames({ ...names, [String(n.incoming.id)]: e.currentTarget.value })}>
                    {n.matches.map((m) => <option key={String(m.person.id)} value={String(m.person.id)}>Same as “{String(m.person.display_name)}” ({m.reason})</option>)}
                    <option value="separate">A different person</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody></table>
          <p class="small muted">When names are merged, the other name is kept as an alias.</p>
        </section>
      )}

      {problem && <p class="notice bad" role="alert">{problem}</p>}
      <div class="row">
        <button class="primary" disabled={!!busy || blocked || (!p.new && duplicates.every((d) => (dups[d.id] ?? all) === "skip"))} onClick={go}>{busy || "Import"}</button>
        <button class="quiet" onClick={cancel}>Cancel</button>
      </div>
      {duplicates.length > 0 && <p class="small muted">Photos are matched by their exact contents, so a renamed copy still counts as already here.</p>}
    </Dialog>
  );
}
