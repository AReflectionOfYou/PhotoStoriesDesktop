// Bringing a photo into the project. The person's own file is only read:
// it is copied in (full size, or resized if they chose that), and the working
// copy image.jpg and a thumbnail are made from the copy.

import { addPhoto, buildXmp, hasStory, listPhotoIds, readPhoto, uuid, writePhoto, writeXmp, type PhotoDoc, type ProjectData } from "photostories-core";
import { APP } from "../state";
import { bitmapOf, scaled, toJpeg, uprightJpeg } from "./image";
import type { Settings } from "./settings";
import { fs } from "./tauri-adapter";

const isJpegName = (n: string) => /\.jpe?g$/i.test(n);

export async function copyIntoProject(root: string, project: ProjectData, settings: Settings, sourcePath: string): Promise<{ doc: PhotoDoc; existing: boolean }> {
  const name = sourcePath.split("/").pop() ?? "photo";
  let from = sourcePath;
  let temp: string | null = null;
  if (settings.copySize === "resized") {
    // A smaller copy, keeping the camera's EXIF when the photo is a JPEG.
    let small = await uprightJpeg(sourcePath, settings.maxLongEdge);
    if (isJpegName(name)) small = writeXmp(small, buildXmp({}), { carryFrom: await fs.readFile(sourcePath) });
    temp = `${root}/.photostories/tmp/${uuid()}.jpg`;
    await fs.mkdir(`${root}/.photostories/tmp`);
    await fs.writeFile(temp, small);
    from = temp;
  }
  try {
    const r = await addPhoto(fs, root, project, {
      sourcePath: from,
      sourceFilename: settings.copySize === "resized" ? name.replace(/\.[^.]+$/, ".jpg") : name,
      copySize: settings.copySize,
      maxLongEdge: settings.maxLongEdge,
      app: APP,
    });
    if (r.existing) return r;
    const doc = r.doc;
    doc.provenance = { ...doc.provenance, source_path: sourcePath, source_filename: name };
    const dir = `${root}/photos/${doc.photo.id}`;
    // The working copy starts as the upright original.
    const image = await uprightJpeg(`${dir}/${doc.files.original}`);
    await fs.writeFile(`${dir}/image.jpg`, image);
    await fs.writeFile(`${dir}/thumb.jpg`, await toJpeg(scaled(await bitmapOf(image), 480), 0.85));
    doc.files.image = "image.jpg";
    doc.files.thumb = "thumb.jpg";
    doc.photo.derived_path = `photos/${doc.photo.id}/image.jpg`;
    await writePhoto(fs, root, doc, project);
    return { doc, existing: false };
  } finally {
    if (temp) await fs.remove(temp);
  }
}

export interface ProjectPhoto {
  id: string;
  title: string;
  sourcePath: string;
  storied: boolean;
  created: string;
}

export async function projectPhotos(root: string): Promise<ProjectPhoto[]> {
  const out: ProjectPhoto[] = [];
  for (const id of await listPhotoIds(fs, root)) {
    const doc = await readPhoto(fs, root, id).catch(() => null);
    if (!doc) continue;
    out.push({
      id,
      title: String(doc.details?.caption || doc.photo.original_filename || "Untitled"),
      sourcePath: String(doc.provenance?.source_path ?? ""),
      storied: hasStory(doc),
      created: String(doc.photo.created_at ?? ""),
    });
  }
  return out.sort((a, b) => a.created.localeCompare(b.created));
}
