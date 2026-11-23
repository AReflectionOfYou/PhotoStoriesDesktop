// One photo: crop and clean up the copy, tell its story, name the faces,
// review the cleaned story and suggestions, and save.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  addFace, buildXmp, contextFrom, dismissFace, ensurePerson, planEmbedded, readEmbedded, readPhoto, recordEdit,
  setDetails, setStory, tagFace, toEdtf, uuid, valuesFor, writePhoto, writeXmp,
  type Certainty, type EmbeddedValues, type MetadataConflict, type PhotoDoc,
} from "photostories-core";
import { Recorder, type Finished } from "../components/Recorder";
import { chooseProvider, describeError, type Suggestions } from "../lib/cleanup";
import { detectFaces } from "../lib/faceDetector";
import { bitmapOf, isUnedited, mapBox, NO_EDITS, render, scaled, toJpeg, unmapBox, uprightJpeg, type Edits } from "../lib/image";
import { downloadProgress, preloadModel, watchDownloads } from "../lib/model";
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
  }, [shown]);

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
    if (!n) return tagFace(doc!, faceId, null, app.owner), touch();
    const person = ensurePerson(app.project, n, app.owner);
    tagFace(doc!, faceId, String(person.id), app.owner);
    touch();
  }

  function addPersonWithoutFace(name: string) {
    const person = ensurePerson(app.project, name, app.owner);
    if (doc!.people_in_photo.some((p) => p.person_id === person.id && !p.removed_at)) return;
    doc!.people_in_photo.push({ id: uuid(), group_id: doc!.photo.group_id, photo_id: doc!.photo.id, person_id: person.id, face_id: null, certainty: null, source: "person", added_by: app.owner, added_at: new Date().toISOString(), removed_by: null, removed_at: null });
    touch();
  }

  function removePerson(personId: string) {
    const now = new Date().toISOString();
    for (const f of faces) if (f.person_id === personId) tagFace(doc!, f.id, null, app.owner);
    for (const p of doc!.people_in_photo) if (p.person_id === personId && !p.removed_at) Object.assign(p, { removed_by: app.owner, removed_at: now });
    touch();
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
      d.photo.file_metadata = { embedded_in_original: Object.fromEntries(Object.entries(embedded).filter(([k]) => k !== "sources")), sources: embedded.sources, choices: remembered, written_at: new Date().toISOString() };
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
              if (f) { Object.assign(f, { bbox_x: b.x, bbox_y: b.y, bbox_w: b.w, bbox_h: b.h }); touch(); }
            }}
            onDrawn={(b) => {
              if (mode === "crop") changeEdits({ ...edits, crop: b });
              if (mode === "addFace") { const f = addFace(doc, b, app.owner, { detector: "manual" }); setSelected(f.id); touch(); }
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
            {mode === "addFace" && <p class="small muted">Drag a box around the face that was missed.</p>}
            {!faces.length && <p class="small muted">{doc.photo.face_detection ? "No faces were found. You can add a box by hand, or just add names below." : "Looking for faces…"}</p>}
            {faces.length > 0 && <p class="small muted">Drag a box to move it, or its yellow corner to resize it. Then type each person's name below.</p>}
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
            <datalist id="known-names">{knownNames.map((n) => <option key={n} value={n} />)}</datalist>
          </section>
        </section>

        <section class="stack" aria-label="Story">
          <div class="card stack">
            <h3>Tell the story</h3>
            <p class="small muted">Who is in it, when and where it was taken, what was happening, and why it matters to you.</p>
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
              <label style="flex:2">When<input type="text" value={dateText} placeholder="summer of 1965, the 1970s, about 1958…" onInput={(e) => { setDateText(e.currentTarget.value); touch(); }} /></label>
              <label style="flex:1">How sure<select value={dateSure} onChange={(e) => { setDateSure(e.currentTarget.value as Certainty); touch(); }}><option value="">—</option><option value="sure">Sure</option><option value="likely">Think so</option><option value="guess">Guessing</option></select></label>
            </div>
            {dateText && <p class="small muted">{toEdtf(dateText) ? `Saved for archives as ${toEdtf(dateText)}.` : "No year found; it's kept as written."}</p>}
            <label>Where<input type="text" value={place} onInput={(e) => { setPlace(e.currentTarget.value); touch(); }} /></label>
            <label>Notes<textarea rows={3} value={notes} onInput={(e) => { setNotes(e.currentTarget.value); touch(); }} /></label>
            {suggested && <SuggestionsPanel s={suggested} title={title} date={dateText} place={place} peopleHere={peopleHere.map(personName)}
              onTitle={(v) => { setTitle(v); touch(); }} onDate={(v) => { setDateText(v); touch(); }} onPlace={(v) => { setPlace(v); touch(); }} onPerson={addPersonWithoutFace} onDone={() => setSuggested(null)} />}
          </div>
        </section>
      </div>

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
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setValue(name), [name]);
  useEffect(() => { if (selected) input.current?.focus({ preventScroll: true }); }, [selected]);
  return (
    <div class="row" style={selected ? "background:#fff;border-radius:10px;padding:4px" : "padding:4px"}>
      <span class="small" style="width:4.5rem">Face {index}</span>
      <input ref={input} type="text" list="known-names" value={value} placeholder="Name" style="flex:1"
        onFocus={onSelect} onInput={(e) => setValue(e.currentTarget.value)} onBlur={() => value !== name && onName(value)}
        onKeyDown={(e) => e.key === "Enter" && onName(value)} aria-label={`Name for face ${index}`} />
      <SpeakName onHeard={(n) => { setValue(n); onName(n); }} />
      <button class="quiet small" onClick={onRemove} title="Not a face">Not a face</button>
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
  const add = () => { if (v.trim()) { onAdd(v.trim()); setV(""); } };
  return (
    <div class="row">
      <input type="text" list="known-names" value={v} placeholder={label} aria-label={label} style="flex:1" onInput={(e) => setV(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
      <button onClick={add} disabled={!v.trim()}>Add</button>
      <datalist id="known-names-2">{knownNames.map((n) => <option key={n} value={n} />)}</datalist>
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
