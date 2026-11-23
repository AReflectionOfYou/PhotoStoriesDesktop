// What the photo file itself says about when and where it was taken: the
// camera's date, any place name saved by photo software, and map coordinates.
// Used to fill in When and Where the first time a photo is opened.

import { invoke } from "@tauri-apps/api/core";
import { readEmbedded } from "photostories-core";

export interface PhotoFacts {
  /** e.g. "July 4, 2019". */
  date?: string;
  place?: string;
  latitude?: number;
  longitude?: number;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2019-07-04" → "July 4, 2019"; "2019-07-04T15:05:00" → "July 4, 2019, 3:05 PM". Anything else is returned as is. */
export function friendlyDate(iso: string): string {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2}))?)?)?/.exec(iso.trim());
  if (!m) return iso;
  const [, y, mo, d, hh, mm] = m;
  const month = mo ? MONTHS[Number(mo) - 1] : undefined;
  if (!month) return y;
  if (!d || !Number(d)) return `${month} ${y}`;
  const day = `${month} ${Number(d)}, ${y}`;
  if (hh === undefined) return day;
  const h = Number(hh);
  return `${day}, ${h % 12 || 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
}

const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8;

/**
 * Read the facts from the original file, or, when that isn't a JPEG (HEIC,
 * PNG…), from its JPEG rendering, which keeps the camera's data on macOS.
 */
export function photoFacts(original: Uint8Array, rendered?: Uint8Array): PhotoFacts {
  for (const bytes of [original, rendered]) {
    if (!bytes || !isJpeg(bytes)) continue;
    try {
      const e = readEmbedded(bytes);
      const facts: PhotoFacts = {};
      if (e.date) facts.date = friendlyDate(e.date);
      if (e.place) facts.place = e.place;
      if (e.latitude !== undefined && e.longitude !== undefined && (e.latitude !== 0 || e.longitude !== 0)) {
        facts.latitude = e.latitude;
        facts.longitude = e.longitude;
      }
      if (Object.keys(facts).length) return facts;
    } catch {
      // Unreadable metadata: there's simply nothing to fill in.
    }
  }
  return {};
}

/** An OpenStreetMap address as a short place name, e.g. "Collegeville, Minnesota, United States". */
export function formatAddress(a: Record<string, string>): string {
  const local = a.city ?? a.town ?? a.village ?? a.hamlet ?? a.municipality ?? a.suburb ?? a.county;
  const parts = [a.tourism ?? a.attraction ?? a.park ?? undefined, local, a.state ?? a.region ?? a.province, a.country];
  return [...new Set(parts.filter(Boolean))].join(", ");
}

/** Look up the place name for map coordinates (sends only the coordinates to OpenStreetMap). */
export async function lookUpPlace(latitude: number, longitude: number): Promise<string | null> {
  const json = await invoke<string | null>("place_name", { lat: latitude, lon: longitude });
  if (!json) return null;
  return formatAddress(JSON.parse(json)) || null;
}
