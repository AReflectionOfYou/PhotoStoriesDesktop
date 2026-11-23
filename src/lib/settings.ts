// App settings, kept in a small JSON file in the app's config folder.
// (Project details such as the owner's name and license live in the project
// itself, in group.json, so they travel with it.)

import { appConfigDir, join } from "@tauri-apps/api/path";
import { readText, writeText } from "photostories-core";
import { fs } from "./tauri-adapter";

export type Provider = "none" | "anthropic" | "openai";

export interface Settings {
  projectRoot: string | null;
  recentProjects: string[];
  sourceFolder: string | null;
  /** Whisper model: "small" (default) or "medium". */
  model: "small" | "medium";
  /** Save the copy at full size, or resized to a maximum long edge. */
  copySize: "full" | "resized";
  maxLongEdge: number;
  /** Write the story into the copy's embedded description. */
  embedStory: boolean;
  /** Keep the recording beside the photo (audio/<id>.wav). */
  keepRecordings: boolean;
  provider: Provider;
  anthropicModel: string;
  openaiModel: string;
}

export const DEFAULTS: Settings = {
  projectRoot: null,
  recentProjects: [],
  sourceFolder: null,
  model: "small",
  copySize: "full",
  maxLongEdge: 3000,
  embedStory: true,
  keepRecordings: true,
  provider: "none",
  anthropicModel: "claude-opus-5-5",
  openaiModel: "gpt-5-mini",
};

async function file() {
  return join(await appConfigDir(), "settings.json");
}

export async function loadSettings(): Promise<Settings> {
  try {
    return { ...DEFAULTS, ...JSON.parse(await readText(fs, await file())) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await writeText(fs, await file(), `${JSON.stringify(s, null, 2)}\n`);
}
