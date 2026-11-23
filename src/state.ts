// What every screen shares: settings, the open project, and how to change them.

import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { ProjectData } from "photostories-core";
import type { Settings } from "./lib/settings";

export const APP = { name: "photostories-desktop", version: "0.1.0" };

export interface AppState {
  settings: Settings;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  root: string;
  project: ProjectData;
  reloadProject(): Promise<void>;
  saveProjectData(keys?: (keyof ProjectData)[]): Promise<void>;
  /** The storyteller id for this computer's owner. */
  owner: string;
}

export const Ctx = createContext<AppState | null>(null);
export const useApp = () => useContext(Ctx)!;
