// What every screen shares: settings, the open project, and how to change them.

import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { ProjectData } from "photostories-core";
import type { Settings } from "./lib/settings";

export const APP = { name: "photostories-desktop", version: "0.1.3" };

export interface AppState {
  settings: Settings;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  root: string;
  project: ProjectData;
  reloadProject(): Promise<void>;
  saveProjectData(keys?: (keyof ProjectData)[]): Promise<void>;
  /** The storyteller id for this computer's owner. */
  owner: string;
  /** This session: the collection being worked on (null = all of them, so adding asks). */
  collectionId: string | null;
  setCollectionId(id: string | null): void;
  /** Add a collection and save it; returns its id. */
  addCollection(name: string): Promise<string>;
  /** The "How to tell it" tips, which stay open across photos until closed. */
  tipsOpen: boolean;
  setTipsOpen(open: boolean): void;
  /** Photos opened during this session, for the wrap-up. */
  opened: string[];
}

/**
 * The photo open in the editor, so leaving or finishing from anywhere can
 * save it first. save() resolves to false if the person cancelled.
 */
export const openPhoto: { dirty: boolean; save: () => Promise<boolean> } = { dirty: false, save: async () => true };

export const Ctx = createContext<AppState | null>(null);
export const useApp = () => useContext(Ctx)!;
