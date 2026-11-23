// One photo: crop and clean up the copy, tell its story, name the faces,
// review the cleaned story and suggestions, and save.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  addFace, buildXmp, contextFrom, dismissFace, ensurePerson, planEmbedded, readEmbedded, readPhoto, recordEdit,
  setDetails, setStory, tagFace, toEdtf, uuid, valuesFor, writePhoto, writeXmp,
  type Certainty, type EmbeddedValues, type MetadataConflict, type PhotoDoc,
} from "photostories-core";
import { Dialog } from "../components/Dialog";
import { Recorder, type Finished } from "../components/Recorder";
import { chooseProvider, describeError, type Suggestions } from "../lib/cleanup";
import { detectFaces } from "../lib/faceDetector";
import { bitmapOf, isUnedited, mapBox, NO_EDITS, render, scaled, toJpeg, unmapBox, uprightJpeg, type Edits } from "../lib/image";
import { downloadProgress, preloadModel, watchDownloads } from "../lib/model";
import { lookUpPlace, photoFacts } from "../lib/prefill";
import { fs } from "../lib/tauri-adapter";
import { useApp } from "../state";

type Mode = "view" | "crop" | "addFace";
type Box = { x: number; y: number; w: number; h: number };

const FIELD_LABEL: Record<string, string> = { title: "Title", description: "Description (the story)", date: "Date", place: "Place", keywords: "Keywords", people: "People", latitude: "Latitude", longitude: "Longitude" };
const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v ?? ""));

export function Editor({ photoId, onClose }: { photoId: string; onClose(): void }) {
  const app = useApp();
  const dir = `${app.root}/photos/${photoId}`;
  const [doc, setDoc] = useState<PhotoDoc | null>(null);
  const [original, setOriginal] = useState<ImageBitmap | null>(null);
  const [preview, setPreview] = useState<ImageBitmap | null>(null);
  const [edits, setEdits] = useState<Edits>(NO_EDITS);
  const [mode, setMode] = useState<Mode>("view");
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  const [saved, setSaved] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [recording, setRecording] = useState(false);
  // Form fields.
  const [title, setTitle] = useState("");
  const [transcript, setTranscript] = useState("");
  const [story, setStoryText] = useState("");
  const [dateText, setDateText] = useState("");
  const [dateSure, setDateSure] = useState<Certainty | "">("");
  const [place, setPlace] = useState("");
  const [notes, setNotes] = useState("");
  const [cleanup, setCleanup] = useState<{ method: string; model: string | null } | null>(null);
  const [transcriptModel, setTranscriptModel] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<Suggestions | null>(null);
  const [conflicts, setConflicts] = useState<MetadataConflict[] | null>(null);
  const [pendingSave, setPendingSave] = useState<null | ((choices: Record<string, "embedded" | "ours">) => Promise<void>)>(null);
  const [, force] = useState(0);
  const [lookingUp, setLookingUp] = useState(false);
  const [coaching, setCoaching] = useState(false);
  const addedHere = useRef(new Set<string>());
  const [placeAlways, setPlaceAlways] = useState(true);
  const touch = () => { setDirty(true); setSaved(false); force((n) => n + 1); };

  // Get the speech model ready now, so Record starts at once: right away if
  // it's downloaded, or as soon as a background download finishes.
  useEffect(() => {
    const m = app.settings.model;
    preloadModel(m);
    return watchDownloads(() => {
      if (downloadProgress(m) === null) preloadModel(m);
    });
  }, [app.settings.model]);

  // Load the sidecar and the as-copied original.
  useEffect(() => {
    (async () => {
      const d = await readPhoto(fs, app.root, photoId);
      const bytes = await uprightJpeg(`${dir}/${d.files.original}`);
      // The first time a photo is opened, fill When and Where from the photo file itself.
      if (!d.photo.file_metadata?.prefilled_at) {
        const facts = photoFacts(await fs.readFile(`${dir}/${d.files.original}`), bytes);
        const now0 = d.details ?? {};
        const patch: Record<string, unknown> = {};
        if (facts.date && !now0.date_text) Object.assign(patch, { date_text: facts.date, date_edtf: toEdtf(facts.date) });
        if (facts.place && !now0.place_text) patch.place_text = facts.place;
        if (facts.latitude !== undefined && now0.latitude == null) Object.assign(patch, { latitude: facts.latitude, longitude: facts.longitude });
        if (!patch.place_text && !now0.place_text && facts.latitude !== undefined && app.settings.lookUpPlaces) {
          const name = await lookUpPlace(facts.latitude, facts.longitude!).catch(() => null);
          if (name) patch.place_text = name;
        }
        if (Object.keys(patch).length) setDetails(d, patch, app.owner, { source: "photo-file" });
        d.photo.file_metadata = { ...(d.photo.file_metadata ?? {}), prefilled_at: new Date().toISOString() };
        await writePhoto(fs, app.root, d, app.project).catch(() => {});
      }
      const bmp = await bitmapOf(bytes);
      setOriginal(bmp);
      setPreview(await createImageBitmap(scaled(bmp, 1800)));
      const saved = d.photo.crop_params?.desktop as Edits | undefined;
      setEdits(saved ?? NO_EDITS);
      const f = d.details ?? {};
      setTitle(f.caption ?? "");
      setDateText(f.date_text ?? "");
      setDateSure((f.date_certainty as Certainty) ?? "");
      setPlace(f.place_text ?? "");
      setNotes(f.notes ?? "");
      const c = d.contributions.find((x) => x.kind === "story" && !x.parent_id && !x.deleted_at);
      setTranscript(c?.transcript ?? "");
      setStoryText(c?.story_text ?? c?.transcript_edited_text ?? "");
      setCleanup(c?.story_cleanup ?? null);
      setTranscriptModel(c?.transcript_model ?? null);
      setDoc(d);
      // The first photo ever opened without a story: show how to tell one.
      if (!app.settings.storyTipsSeen && !c?.transcript && !c?.story_text) {
        setCoaching(true);
        void app.updateSettings({ storyTipsSeen: true });
      }
    })().catch((e) => setProblem(String(e)));
  }, [photoId]);

  // The picture as edited, for the screen.
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shown = useMemo(() => (preview ? render(preview, mode === "crop" ? { ...edits, crop: NO_EDITS.crop } : edits) : null), [preview, edits, mode]);
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !shown) return;
    c.width = shown.width;
    c.height = shown.height;
    c.getContext("2d")!.drawImage(shown, 0, 0);
  }, [shown, !!doc]); // the canvas only exists once the photo's details are loaded

  // Find faces once, the first time the photo is opened.
  useEffect(() => {
    if (!doc || !preview || doc.photo.face_detection) return;
    (async () => {
      setBusy("Looking for faces…");
      const found = await detectFaces(render(preview, edits));
      doc.photo.face_detection = { detector: found?.detector ?? "unavailable", at: new Date().toISOString(), found: found?.faces.length ?? 0 };
      for (const f of found?.faces ?? []) addFace(doc, f, app.owner, { detector: found!.detector, confidence: f.score });
      // Keep what was found right away, so just looking at a photo never leaves "unsaved changes".
      await writePhoto(fs, app.root, doc, app.project).catch(() => {});
      setBusy("");
      force((n) => n + 1);
    })();
  }, [doc, preview]);

  if (!doc || !shown) return <p class="muted">{problem || "Opening the photo…"}</p>;

  const faces = doc.faces.filter((f) => !f.dismissed && (f.image ?? "front") === "front");
  const personName = (id: string | null) => app.project.people.find((p) => p.id === id)?.display_name ?? "";
  const knownNames = app.project.people.map((p) => String(p.display_name));
  const peopleHere = [...new Set(doc.people_in_photo.filter((p) => !p.removed_at).map((p) => String(p.person_id)))];

  /** Names and face boxes are kept as soon as they change, without waiting for Save. */
  async function keepPeople() {
    force((n) => n + 1);
    try {
      await writePhoto(fs, app.root, doc!, app.project);
      await app.saveProjectData(["people"]);
    } catch (e) {
      setProblem(`Couldn't save the names: ${e}`);
    }
  }

  /** True when a field still holds the value read from the photo file. */
  const fromFile = (field: string, value: string) => {
    const h = doc!.field_history.filter((x) => x.field === field).at(-1);
    return !!value && h?.source === "photo-file" && h.new_value === value;
  };

  async function findPlace() {
    const d = doc!.details;
    if (d?.latitude == null || d?.longitude == null) return;
    setLookingUp(true);
    setProblem("");
    try {
      const name = await lookUpPlace(Number(d.latitude), Number(d.longitude));
      if (name) { setPlace(name); touch(); } else setProblem("OpenStreetMap has no place name for this spot.");
      if (placeAlways) await app.updateSettings({ lookUpPlaces: true });
    } catch (e) {
      setProblem(`Couldn't look up the place (is the computer online?): ${e}`);
    } finally {
      setLookingUp(false);
    }
  }

  function changeEdits(next: Edits) {
    // Keep face boxes on the same faces when the crop or rotation changes.
    for (const f of faces) {
      const o = unmapBox({ x: f.bbox_x, y: f.bbox_y, w: f.bbox_w, h: f.bbox_h }, edits);
      const n = mapBox(o, next);
      if (!n) dismissFace(doc!, f.id, app.owner);
      else Object.assign(f, { bbox_x: n.x, bbox_y: n.y, bbox_w: n.w, bbox_h: n.h });
    }
    setEdits(next);
    touch();
  }

  function nameFace(faceId: string, name: string) {
    const n = name.trim();
    const before = doc!.faces.find((f) => f.id === faceId)?.person_id ?? null;
    if (!n) tagFace(doc!, faceId, null, app.owner);
    else {
      const known = new Set(app.project.people.map((p) => p.id));
      const person = ensurePerson(app.project, n, app.owner);
      if (!known.has(person.id)) addedHere.current.add(String(person.id));
      tagFace(doc!, faceId, String(person.id), app.owner);
    }
    forgetIfUnused(before);
    return keepPeople();
  }

  /** A name typed here and then changed (say "Rose" → "Rose Martinez") shouldn't linger in the project's list of people. */
  function forgetIfUnused(personId: string | null) {
    if (!personId || !addedHere.current.has(personId)) return;
    const used = doc!.faces.some((f) => f.person_id === personId) || doc!.people_in_photo.some((p) => p.person_id === personId && !p.removed_at);
    if (used) return;
    app.project.people.splice(app.project.people.findIndex((p) => p.id === personId), 1);
    addedHere.current.delete(personId);
  }

  function addPersonWithoutFace(name: string) {
    const person = ensurePerson(app.project, name, app.owner);
    if (doc!.people_in_photo.some((p) => p.person_id === person.id && !p.removed_at)) return;
    doc!.people_in_photo.push({ id: uuid(), group_id: doc!.photo.group_id, photo_id: doc!.photo.id, person_id: person.id, face_id: null, certainty: null, source: "person", added_by: app.owner, added_at: new Date().toISOString(), removed_by: null, removed_at: null });
    void keepPeople();
  }

  function removePerson(personId: string) {
    const now = new Date().toISOString();
    for (const f of faces) if (f.person_id === personId) tagFace(doc!, f.id, null, app.owner);
    for (const p of doc!.people_in_photo) if (p.person_id === personId && !p.removed_at) Object.assign(p, { removed_by: app.owner, removed_at: now });
    void keepPeople();
  }

  async function runCleanup() {
    setBusy("Cleaning up the story…");
    setProblem("");
    try {
      const provider = await chooseProvider(app.settings);
      const s = await provider.clean(transcript, knownNames);
      setStoryText(s.story);
      setCleanup({ method: provider.id === "none" ? "local" : provider.id, model: provider.model });
      if (!title && s.title) setTitle(s.title);
      if (!dateText && s.date) setDateText(s.date);
      if (!place && s.place) setPlace(s.place);
      setSuggested(s);
      touch();
    } catch (e) {
      setProblem(describeError(e));
    } finally {
      setBusy("");
    }
  }

  function storyContributionId(): string {
    let c = doc!.contributions.find((x) => x.kind === "story" && !x.parent_id && !x.deleted_at);
    if (!c) c = setStory(doc!, {}, app.owner);
    return String(c.id);
  }

  function recorded(r: Finished, fresh: boolean) {
    const next = fresh || !transcript ? r.text : `${transcript} ${r.text}`;
    setTranscript(next);
    setTranscriptModel(`whisper-${r.model}`);
    if (r.wav) {
      const cid = storyContributionId();
      const rel = r.wav.slice(dir.length + 1);
      const audio = (doc!.files.audio ??= {});
      const prev = fresh ? [] : ((audio[cid]?.parts as string[]) ?? (audio[cid]?.original ? [String(audio[cid].original)] : []));
      audio[cid] = { original: prev[0] ?? rel, parts: [...prev, rel] };
      const c = doc!.contributions.find((x) => x.id === cid)!;
      c.audio_path = audio[cid].original;
      c.audio_original_mime = "audio/wav";
      c.audio_duration_s = (fresh ? 0 : Number(c.audio_duration_s ?? 0)) + r.seconds;
    }
    touch();
  }

  async function save(choices?: Record<string, "embedded" | "ours">) {
    setBusy("Saving…");
    setProblem("");
    try {
      const d = doc!;
      setDetails(d, { caption: title, date_text: dateText, date_edtf: toEdtf(dateText), place_text: place, notes, certainty: dateText ? { date_text: dateSure || null } : {} }, app.owner);
      if (transcript || story || d.contributions.some((c) => c.kind === "story" && !c.deleted_at)) {
        setStory(d, { transcript: transcript || null, transcriptModel, storyText: story || null, cleanup: story ? (cleanup ?? { method: "none", model: null }) : null }, app.owner);
      }
      // The edited working copy, from the untouched original.
      const prevEdits = (d.photo.crop_params?.desktop as Edits | undefined) ?? NO_EDITS;
      if (JSON.stringify(prevEdits) !== JSON.stringify(edits)) {
        recordEdit(d, isUnedited(edits) ? "reset" : "edit", { rotate: edits.rotate, crop: edits.crop, brightness: edits.brightness, contrast: edits.contrast, auto_enhance: edits.autoEnhance });
        d.photo.crop_params = isUnedited(edits) ? null : { desktop: edits };
      }
      const canvas = render(original!, edits);
      let jpeg = await toJpeg(canvas);
      // Embedded metadata: fill what's missing; ask before replacing anything.
      const originalBytes = await fs.readFile(`${dir}/${d.files.original}`);
      const isJpeg = originalBytes[0] === 0xff && originalBytes[1] === 0xd8;
      const embedded = isJpeg ? readEmbedded(originalBytes) : { sources: {} };
      const ours = valuesFor(d, contextFrom(app.project.group, app.project.people, app.project.contributors), { includeStory: app.settings.embedStory });
      // Values read from the photo file and left as they were aren't ours to question.
      if (fromFile("date_text", dateText)) delete ours.date;
      if (fromFile("place_text", place)) delete ours.place;
      if (d.field_history.filter((h) => h.field === "latitude").at(-1)?.source === "photo-file") { delete ours.latitude; delete ours.longitude; }
      const plan = planEmbedded(embedded, ours);
      const remembered = { ...((d.photo.file_metadata?.choices as Record<string, "embedded" | "ours">) ?? {}), ...(choices ?? {}) };
      const open = plan.conflicts.filter((c) => !remembered[c.field]);
      if (open.length) {
        setBusy("");
        setConflicts(open);
        setPendingSave(() => (picked: Record<string, "embedded" | "ours">) => save({ ...remembered, ...picked }));
        return;
      }
      const values: EmbeddedValues = { ...plan.values };
      const replaced: (keyof EmbeddedValues)[] = [];
      for (const c of plan.conflicts) if (remembered[c.field] === "ours") ((values as Record<string, unknown>)[c.field] = c.ours), replaced.push(c.field);
      const named = faces.filter((f) => f.person_id).map((f) => ({ x: +f.bbox_x, y: +f.bbox_y, w: +f.bbox_w, h: +f.bbox_h, name: personName(f.person_id) }));
      jpeg = writeXmp(jpeg, buildXmp(values, { photoId: String(d.photo.id), schemaVersion: String(d.schema_version), faces: named, width: canvas.width, height: canvas.height }), { carryFrom: isJpeg ? originalBytes : undefined, replaced });
      await fs.writeFile(`${dir}/image.jpg`, jpeg);
      await fs.writeFile(`${dir}/thumb.jpg`, await toJpeg(scaled(canvas, 480), 0.85));
      d.files.image = "image.jpg";
      d.files.thumb = "thumb.jpg";
      d.photo.file_metadata = { ...(d.photo.file_metadata ?? {}), embedded_in_original: Object.fromEntries(Object.entries(embedded).filter(([k]) => k !== "sources")), sources: embedded.sources, choices: remembered, written_at: new Date().toISOString() };
      await writePhoto(fs, app.root, d, app.project);
      await app.saveProjectData(["people"]);
      setDirty(false);
      setSaved(true);
    } catch (e) {
      setProblem(`Couldn't save: ${e}`);
    } finally {
      setBusy("");
    }
  }

  return (
    <div class="stack">
      <div class="spread">
        <button class="quiet" onClick={() => (dirty ? setConfirmLeave(true) : onClose())}>← All photos</button>
        <div class="row">
          {busy && <span class="muted" role="status">{busy}</span>}
          {saved && !dirty && <span class="muted" role="status">Saved.</span>}
          <button class="primary" disabled={!!busy || recording} onClick={() => save()}>Save</button>
        </div>
      </div>
      {confirmLeave && (
        <div class="notice row" role="alertdialog" aria-label="Unsaved changes">
          <span>You have changes that aren't saved.</span>
          <button class="primary" onClick={async () => { await save(); setConfirmLeave(false); }}>Save</button>
          <button class="danger" onClick={onClose}>Leave without saving</button>
          <button class="quiet" onClick={() => setConfirmLeave(false)}>Stay</button>
        </div>
      )}
      {problem && <p class="notice bad" role="alert">{problem}</p>}

      <div class="editor">
        <section class="stack" aria-label="Photo">
          <Stage
            canvasRef={canvasRef}
            size={{ w: shown.width, h: shown.height }}
            mode={mode}
            crop={edits.crop}
            faces={mode === "crop" ? [] : faces.map((f) => ({ id: f.id, box: { x: f.bbox_x, y: f.bbox_y, w: f.bbox_w, h: f.bbox_h }, name: personName(f.person_id) }))}
            selected={selected}
            onSelect={setSelected}
            onBoxChange={(id, b) => {
              const f = doc.faces.find((x) => x.id === id);
              if (f) { Object.assign(f, { bbox_x: b.x, bbox_y: b.y, bbox_w: b.w, bbox_h: b.h }); void keepPeople(); }
            }}
            onDrawn={(b) => {
              if (mode === "crop") changeEdits({ ...edits, crop: b });
              if (mode === "addFace") { const f = addFace(doc, b, app.owner, { detector: "manual" }); setSelected(f.id); void keepPeople(); }
              setMode("view");
            }}
          />
          <div class="row">
            <button onClick={() => changeEdits({ ...edits, rotate: ((edits.rotate + 270) % 360) as Edits["rotate"], crop: NO_EDITS.crop })} aria-label="Rotate left">↺ Rotate</button>
            <button onClick={() => changeEdits({ ...edits, rotate: ((edits.rotate + 90) % 360) as Edits["rotate"], crop: NO_EDITS.crop })} aria-label="Rotate right">↻ Rotate</button>
            <button aria-pressed={mode === "crop"} onClick={() => setMode(mode === "crop" ? "view" : "crop")}>{mode === "crop" ? "Cancel crop" : "Crop"}</button>
            <label class="inline"><input type="checkbox" checked={edits.autoEnhance} onChange={(e) => changeEdits({ ...edits, autoEnhance: e.currentTarget.checked })} /> Auto-enhance</label>
            <button class="quiet" onClick={() => changeEdits(NO_EDITS)} disabled={isUnedited(edits)}>Reset to as copied</button>
          </div>
          {mode === "crop" && <p class="small muted">Drag across the photo to choose what to keep.</p>}
          <div class="row">
            <label class="inline">Brightness <input type="range" min={-60} max={60} value={edits.brightness} onChange={(e) => changeEdits({ ...edits, brightness: +e.currentTarget.value })} /></label>
            <label class="inline">Contrast <input type="range" min={-60} max={60} value={edits.contrast} onChange={(e) => changeEdits({ ...edits, contrast: +e.currentTarget.value })} /></label>
          </div>
          <p class="small muted">Edits apply only to the copy in this project. Your own photo is never changed.</p>

          <section class="card stack" aria-labelledby="faces-h">
            <div class="spread">
              <h3 id="faces-h">People in this photo</h3>
              <button aria-pressed={mode === "addFace"} onClick={() => setMode(mode === "addFace" ? "view" : "addFace")}>{mode === "addFace" ? "Cancel" : "Add a face box"}</button>
            </div>
            <p class="small">Use each person's first and last name, like “Rose Martinez”, so they're recognized in every photo. If two people share a first and last name, add a middle name or initial: “Rose A. Martinez”.</p>
            {mode === "addFace" && <p class="small muted">Drag a box around the face that was missed.</p>}
            {!faces.length && <p class="small muted">{doc.photo.face_detection ? "No faces were found. You can add a box by hand, or just add names below." : "Looking for faces…"}</p>}
            {faces.length > 0 && <p class="small muted">Drag a box to move it, or its yellow corner to resize it. Names and boxes are saved as you go.</p>}
            {faces.map((f, i) => (
              <FaceRow key={f.id} index={i + 1} name={personName(f.person_id)} selected={selected === f.id} knownNames={knownNames}
                onSelect={() => setSelected(f.id)} onName={(n) => nameFace(f.id, n)} onRemove={() => { dismissFace(doc, f.id, app.owner); touch(); }} />
            ))}
            <AddName knownNames={knownNames} label="Someone without a face box" onAdd={addPersonWithoutFace} />
            <div class="chips">
              {peopleHere.filter((id) => !faces.some((f) => f.person_id === id)).map((id) => (
                <span class="chip" key={id}>{personName(id)}<button class="quiet" aria-label={`Remove ${personName(id)}`} onClick={() => removePerson(id)}>×</button></span>
              ))}
            </div>
          </section>
        </section>

        <section class="stack" aria-label="Story">
          <div class="card stack">
            <div class="spread">
              <h3>Tell the story</h3>
              <button class="quiet small" onClick={() => setCoaching(true)}>How to tell it</button>
            </div>
            <p class="small muted">Skip “This is a photo of…”. Start in the moment: “That summer, we drove to the lake every Sunday…” Then say who's there, what was happening, and why it matters to you.</p>
            {(dateText || place || peopleHere.length > 0) && (
              <p class="small known">Already filled in: {[dateText && `when (${dateText})`, place && `where (${place})`, peopleHere.length > 0 && `who (${peopleHere.map(personName).join(", ")})`].filter(Boolean).join(", ")}. Check that these are right; you don't need to say them again, unless the story behind them matters.</p>
            )}
            <Recorder onBusy={setRecording} wavPath={() => (app.settings.keepRecordings ? `${dir}/audio/${storyContributionId()}-${Date.now()}.wav` : null)} label={transcript ? "Record more" : "Record the story"} onFinished={(r) => recorded(r, false)} />
            {transcript && !recording && (
              <details>
                <summary class="small">What was said (the raw transcript)</summary>
                <textarea aria-label="Raw transcript" value={transcript} onInput={(e) => { setTranscript(e.currentTarget.value); touch(); }} />
              </details>
            )}
            {transcript && !recording && (
              <div class="row">
                <button onClick={runCleanup} disabled={!!busy}>{story ? "Clean up again" : "Clean up into a story"}</button>
                <span class="small muted">{app.settings.provider === "none" ? "Light cleanup on this computer" : `Uses ${app.settings.provider === "anthropic" ? "Anthropic" : "OpenAI"} if a key is set`}</span>
              </div>
            )}
          </div>

          <div class="card stack">
            <label>Title<input type="text" value={title} onInput={(e) => { setTitle(e.currentTarget.value); touch(); }} /></label>
            <label>The story<textarea rows={8} value={story} placeholder={transcript ? "Clean up the transcript, or type the story here." : "Record or type the story here."} onInput={(e) => { setStoryText(e.currentTarget.value); setCleanup((c) => c ?? { method: "none", model: null }); touch(); }} /></label>
            <div class="row" style="align-items:end">
              <label style="flex:2">When<input type="text" autocomplete="off" value={dateText} placeholder="summer of 1965, the 1970s, about 1958…" onInput={(e) => { setDateText(e.currentTarget.value); touch(); }} /></label>
              <label style="flex:1">How sure<select value={dateSure} onChange={(e) => { setDateSure(e.currentTarget.value as Certainty); touch(); }}><option value="">—</option><option value="sure">Sure</option><option value="likely">Think so</option><option value="guess">Guessing</option></select></label>
            </div>
            {dateText && <p class="small muted">{toEdtf(dateText) ? `Saved for archives as ${toEdtf(dateText)}.` : "No year found; it's kept as written."}</p>}
            {fromFile("date_text", dateText) && <p class="small muted">This date comes from the photo file. If this is a scan or a photo of a print, it's when the copy was made, so change it to when the photo was taken.</p>}
            <label>Where<input type="text" autocomplete="off" value={place} onInput={(e) => { setPlace(e.currentTarget.value); touch(); }} /></label>
            {fromFile("place_text", place) && <p class="small muted">This place comes from the photo file.</p>}
            {!place && doc.details?.latitude != null && (
              <div class="notice stack">
                <p class="small">This photo has map coordinates ({Number(doc.details.latitude).toFixed(4)}, {Number(doc.details.longitude).toFixed(4)}).</p>
                <div class="row">
                  <button class="small" onClick={findPlace} disabled={lookingUp}>{lookingUp ? "Looking up…" : "Find the place name"}</button>
                  <label class="inline small"><input type="checkbox" checked={placeAlways} onChange={(e) => setPlaceAlways(e.currentTarget.checked)} /> Do this for every new photo</label>
                </div>
                <p class="small muted">This sends only the coordinates (not the photo) to OpenStreetMap. You can change this later in Settings.</p>
              </div>
            )}
            <label>Notes<textarea rows={3} value={notes} placeholder="Written on the back: “Lake Vermilion, '65”. Original print is in Mom's blue album. Not sure if that's Uncle Joe or Uncle Pete." onInput={(e) => { setNotes(e.currentTarget.value); touch(); }} /></label>
            <p class="small muted">The story is what happened, in your words. Notes are the facts around the photo: what's written on the back, who took it, where the original is kept, and anything you're unsure of or want to ask someone.</p>
            {suggested && <SuggestionsPanel s={suggested} title={title} date={dateText} place={place} peopleHere={peopleHere.map(personName)}
              onTitle={(v) => { setTitle(v); touch(); }} onDate={(v) => { setDateText(v); touch(); }} onPlace={(v) => { setPlace(v); touch(); }} onPerson={addPersonWithoutFace} onDone={() => setSuggested(null)} />}
          </div>
        </section>
      </div>

      {coaching && <StoryCoach known={{ when: dateText, where: place, who: peopleHere.map(personName) }} onClose={() => setCoaching(false)} />}
      {conflicts && pendingSave && <ConflictDialog conflicts={conflicts} onCancel={() => { setConflicts(null); setPendingSave(null); }} onDone={async (picked) => { setConflicts(null); const go = pendingSave; setPendingSave(null); await go(picked); }} />}
    </div>
  );
}

/**
 * The picture with face boxes. The picture and its frame are given the same
 * explicit size, so boxes (placed as fractions of the frame) sit exactly on the
 * faces whether the photo is limited by width or by height. Boxes can be moved
 * by dragging and resized from their corner; drag on the photo to crop or to
 * add a box.
 */
function Stage({ canvasRef, size, mode, crop, faces, selected, onSelect, onDrawn, onBoxChange }: {
  canvasRef: preact.RefObject<HTMLCanvasElement>; size: { w: number; h: number }; mode: Mode; crop: Box; faces: { id: string; box: Box; name: string }[];
  selected: string | null; onSelect(id: string): void; onDrawn(b: Box): void; onBoxChange(id: string, b: Box): void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState({ w: 800, h: 600 });
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [moving, setMoving] = useState<{ id: string; kind: "move" | "resize"; px: number; py: number; start: Box; box: Box; moved: boolean } | null>(null);

  useEffect(() => {
    const measure = () => wrap.current && setAvail({ w: wrap.current.clientWidth, h: Math.max(240, window.innerHeight * 0.68) });
    measure();
    const ro = new ResizeObserver(measure);
    if (wrap.current) ro.observe(wrap.current);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  const scale = Math.min(1, avail.w / size.w, avail.h / size.h);
  const dw = Math.round(size.w * scale), dh = Math.round(size.h * scale);

  const at = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const clampBox = (b: Box): Box => {
    const w = Math.min(1, Math.max(0.01, b.w)), h = Math.min(1, Math.max(0.01, b.h));
    return { x: Math.min(1 - w, Math.max(0, b.x)), y: Math.min(1 - h, Math.max(0, b.y)), w, h };
  };
  const box = drag && { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) };
  const pct = (b: Box) => `left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%`;

  function startBox(e: PointerEvent, id: string, b: Box, kind: "move" | "resize") {
    if (mode !== "view") return;
    e.stopPropagation();
    e.preventDefault();
    ref.current!.setPointerCapture(e.pointerId);
    setMoving({ id, kind, px: e.clientX, py: e.clientY, start: b, box: b, moved: false });
  }

  return (
    <div ref={wrap} class="stage-wrap">
      <div
        ref={ref}
        class="stage"
        style={`width:${dw}px;height:${dh}px;${mode !== "view" ? "cursor:crosshair;" : ""}touch-action:none`}
        onPointerDown={(e) => { if (mode === "view") return; const p = at(e); setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }); ref.current!.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => {
          if (drag) { const p = at(e); setDrag({ ...drag, x1: p.x, y1: p.y }); return; }
          if (!moving) return;
          const dx = (e.clientX - moving.px) / dw, dy = (e.clientY - moving.py) / dh;
          const s0 = moving.start;
          const next = moving.kind === "move" ? clampBox({ ...s0, x: s0.x + dx, y: s0.y + dy }) : clampBox({ ...s0, w: s0.w + dx, h: s0.h + dy });
          setMoving({ ...moving, box: next, moved: moving.moved || Math.abs(e.clientX - moving.px) + Math.abs(e.clientY - moving.py) > 3 });
        }}
        onPointerUp={() => {
          if (drag) { if (box && box.w > 0.02 && box.h > 0.02) onDrawn(box); setDrag(null); return; }
          if (moving) { if (moving.moved) onBoxChange(moving.id, moving.box); onSelect(moving.id); setMoving(null); }
        }}
      >
        <canvas ref={canvasRef} role="img" aria-label="The photo" style={`width:${dw}px;height:${dh}px`} />
        {mode === "crop" && !box && <div class="drag" style={pct(crop)} />}
        {box && <div class="drag" style={pct(box)} />}
        {faces.map((f, i) => {
          const b = moving?.id === f.id ? moving.box : f.box;
          return (
            <div key={f.id} role="button" tabIndex={0} class={`box ${selected === f.id ? "selected" : ""} ${f.name ? "" : "unnamed"}`} style={pct(b)}
              aria-label={`Face ${i + 1}${f.name ? `: ${f.name}` : ", not named yet"}. Drag to move.`}
              onPointerDown={(e) => startBox(e, f.id, f.box, "move")}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 0.02 : 0.005;
                const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(f.id); }
                else if (d[e.key]) { e.preventDefault(); onBoxChange(f.id, clampBox({ ...f.box, x: f.box.x + d[e.key][0], y: f.box.y + d[e.key][1] })); }
              }}>
              <span class="tag">{f.name || `Face ${i + 1}`}</span>
              <span class="handle" aria-hidden="true" onPointerDown={(e) => startBox(e, f.id, f.box, "resize")} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FaceRow({ index, name, selected, knownNames, onSelect, onName, onRemove }: { index: number; name: string; selected: boolean; knownNames: string[]; onSelect(): void; onName(n: string): void; onRemove(): void }) {
  const [value, setValue] = useState(name);
  const [justSaved, setJustSaved] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setValue(name), [name]);
  useEffect(() => { if (selected) input.current?.focus({ preventScroll: true }); }, [selected]);
  const changed = value.trim() !== name;
  const commit = (n = value) => {
    if (n.trim() === name) return;
    setValue(n.trim());
    onName(n);
    setJustSaved(true);
  };
  return (
    <div class={`face-row ${selected ? "selected" : ""}`}>
      <div class="row">
        <span class="small" style="width:4.5rem">Face {index}</span>
        <NameInput inputRef={input} value={value} knownNames={knownNames} placeholder="First and last name" label={`Name for face ${index}`}
          onFocus={onSelect} onChange={(v) => { setValue(v); setJustSaved(false); }} onCommit={commit} />
        {changed
          ? <button class="small" onClick={() => commit()}>Save name</button>
          : name && <span class="small saved" role="status">✓ {justSaved ? "Saved" : "Named"}</span>}
        <SpeakName onHeard={(n) => commit(n)} />
        <button class="quiet small" onClick={onRemove} title="Not a face">Not a face</button>
      </div>
      {!changed && name && !/\s/.test(name) && <p class="small muted tip">Tip: add a last name if you know it, so this person isn't mixed up with someone else named {name}.</p>}
    </div>
  );
}

/**
 * A name box with our own list of matching names from this project. (The
 * browser's built-in suggestion list shows up in the wrong place in the app.)
 */
function NameInput({ value, knownNames, placeholder, label, inputRef, onChange, onCommit, onFocus, blurCommits = true }: {
  value: string; knownNames: string[]; placeholder: string; label: string; inputRef?: preact.RefObject<HTMLInputElement>;
  onChange(v: string): void; onCommit(v: string): void; onFocus?(): void; blurCommits?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const q = value.trim().toLowerCase();
  const matches = q ? knownNames.filter((n) => n.toLowerCase().includes(q) && n.toLowerCase() !== q).slice(0, 6) : [];
  const show = open && matches.length > 0;
  const pick = (n: string) => { onChange(n); onCommit(n); setOpen(false); setActive(-1); };
  return (
    <div class="name-field">
      <input ref={inputRef} type="text" value={value} placeholder={placeholder} aria-label={label}
        autocomplete="off" autocorrect="off" spellcheck={false} role="combobox" aria-expanded={show} aria-autocomplete="list"
        onFocus={() => { setOpen(true); onFocus?.(); }}
        onInput={(e) => { onChange(e.currentTarget.value); setOpen(true); setActive(-1); }}
        onBlur={() => { setOpen(false); if (blurCommits) onCommit(value); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && matches.length) { e.preventDefault(); setOpen(true); setActive((a) => (a + 1) % matches.length); }
          else if (e.key === "ArrowUp" && matches.length) { e.preventDefault(); setActive((a) => (a <= 0 ? matches.length - 1 : a - 1)); }
          else if (e.key === "Escape") setOpen(false);
          else if (e.key === "Enter") { e.preventDefault(); if (show && active >= 0) pick(matches[active]); else { setOpen(false); onCommit(value); } }
        }} />
      {show && (
        <ul class="suggest" role="listbox" aria-label="Names already in this project">
          {matches.map((n, i) => (
            <li key={n} role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); pick(n); }}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Say a name instead of typing it. */
function SpeakName({ onHeard }: { onHeard(name: string): void }) {
  const app = useApp();
  const [on, setOn] = useState(false);
  const toggle = async () => {
    if (!on) {
      try { await invoke("start_recording", { model: app.settings.model, names: app.project.people.map((p) => String(p.display_name)) }); setOn(true); } catch { /* the story recorder shows model problems */ }
      return;
    }
    setOn(false);
    const r = await invoke<{ text: string }>("stop_recording", { discard: false, wav: null }).catch(() => ({ text: "" }));
    const name = r.text.replace(/[.!?,]+$/g, "").trim();
    if (name) onHeard(name);
  };
  return <button class="quiet small" onClick={toggle} aria-pressed={on} title="Say the name">{on ? "■ Done" : "🎤"}</button>;
}

function AddName({ knownNames, label, onAdd }: { knownNames: string[]; label: string; onAdd(n: string): void }) {
  const [v, setV] = useState("");
  const add = (n = v) => { if (n.trim()) { onAdd(n.trim()); setV(""); } };
  return (
    <div class="row">
      <NameInput value={v} knownNames={knownNames} placeholder={label} label={label} onChange={setV} onCommit={(n) => add(n)} blurCommits={false} />
      <button onClick={() => add()} disabled={!v.trim()}>Add</button>
    </div>
  );
}

function SuggestionsPanel({ s, title, date, place, peopleHere, onTitle, onDate, onPlace, onPerson, onDone }: {
  s: Suggestions; title: string; date: string; place: string; peopleHere: string[];
  onTitle(v: string): void; onDate(v: string): void; onPlace(v: string): void; onPerson(n: string): void; onDone(): void;
}) {
  const rows: [string, string, string, (v: string) => void][] = [["Title", s.title, title, onTitle], ["When", s.date, date, onDate], ["Where", s.place, place, onPlace]];
  const newPeople = s.people.filter((p) => !peopleHere.some((h) => h.toLowerCase() === p.toLowerCase()));
  if (!rows.some(([, v, cur]) => v && v !== cur) && !newPeople.length) return null;
  return (
    <div class="notice stack">
      <div class="spread"><strong>Suggestions from the story</strong><button class="quiet small" onClick={onDone}>Hide</button></div>
      {rows.filter(([, v, cur]) => v && v !== cur).map(([label, v, , use]) => (
        <div class="row" key={label}><span class="small" style="width:4rem">{label}</span><span style="flex:1">{v}</span><button class="small" onClick={() => use(v)}>Use</button></div>
      ))}
      {newPeople.length > 0 && <div class="row"><span class="small" style="width:4rem">People</span>{newPeople.map((p) => <button key={p} class="small" onClick={() => onPerson(p)}>+ {p}</button>)}</div>}
    </div>
  );
}

/** Tips for telling a photo's story, as if to someone sitting beside you. */
function StoryCoach({ known, onClose }: { known: { when: string; where: string; who: string[] }; onClose(): void }) {
  const filled = [known.when && `When: ${known.when}`, known.where && `Where: ${known.where}`, known.who.length > 0 && `Who: ${known.who.join(", ")}`].filter(Boolean) as string[];
  return (
    <Dialog title="How to tell the story" onClose={onClose}>
      <div class="stack coach">
        <p>Tell it as if a grandchild were sitting beside you, looking at the photo with you. They can see the picture; what they can't see is what you remember.</p>
        <h3>Start in the moment, not with the photo</h3>
        <p class="compare-tip"><span class="no">Instead of</span> “This is a photo of my mother at the lake.”</p>
        <p class="compare-tip"><span class="yes">Try</span> “Every Sunday that summer, Mom packed sandwiches and we drove out to the lake.”</p>
        <p class="compare-tip"><span class="yes">Or</span> “I'll never forget how cold that water was.”</p>
        <h3>Then, in any order</h3>
        <ul>
          <li><strong>Who's there</strong>, and how you're connected: “my mother, Rose Martinez, on the left, and her brother Joe.”</li>
          <li><strong>What was happening</strong> just before and after the picture was taken.</li>
          <li><strong>Small details</strong>: what people said, the smells, the sounds, the car you drove there in.</li>
          <li><strong>Why it matters</strong>: what it tells about them, or about you, and what you want people to know.</li>
        </ul>
        <h3>Check what's already known</h3>
        {filled.length
          ? <p>These are already filled in from the photo or from your names: {filled.join(" · ")}. Check that they're right; there's no need to say them again, unless the story behind them matters.</p>
          : <p>Many photos carry their own date, time and location. When they do, they're filled in under When and Where, so check those first.</p>}
        <h3>Don't worry about getting it perfect</h3>
        <p>Pauses, “um”s and starting over are fine. You can record more later, and the cleanup tidies the words while keeping them yours.</p>
        <div class="row"><button class="primary" onClick={onClose}>Got it</button></div>
      </div>
    </Dialog>
  );
}

function ConflictDialog({ conflicts, onCancel, onDone }: { conflicts: MetadataConflict[]; onCancel(): void; onDone(picked: Record<string, "embedded" | "ours">): void }) {
  const [picked, setPicked] = useState<Record<string, "embedded" | "ours">>(Object.fromEntries(conflicts.map((c) => [c.field, "embedded"])));
  return (
    <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="conf-h">
      <div class="dialog">
        <h2 id="conf-h">This photo already has some of these details</h2>
        <p>The photo file already holds different values for {conflicts.length === 1 ? "one detail" : "some details"}. Choose which to keep in the copy. (Your own photo isn't changed either way, and everything you entered is saved with the photo's story.)</p>
        <div class="compare">
          <strong /> <strong>Already in the photo</strong> <strong>What you entered</strong>
          {conflicts.map((c) => (
            <>
              <span>{FIELD_LABEL[c.field] ?? c.field}<br /><span class="small muted">({c.source})</span></span>
              <button class="choice" aria-pressed={picked[c.field] === "embedded"} onClick={() => setPicked({ ...picked, [c.field]: "embedded" })}>{show(c.embedded)}</button>
              <button class="choice" aria-pressed={picked[c.field] === "ours"} onClick={() => setPicked({ ...picked, [c.field]: "ours" })}>{show(c.ours)}</button>
            </>
          ))}
        </div>
        <div class="row"><button class="primary" onClick={() => onDone(picked)}>Save with these choices</button><button class="quiet" onClick={onCancel}>Cancel</button></div>
      </div>
    </div>
  );
}
