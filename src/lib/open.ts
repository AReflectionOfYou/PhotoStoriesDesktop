import { openUrl as open, revealItemInDir } from "@tauri-apps/plugin-opener";

/** Open a web link in the person's browser. */
export const openUrl = (url: string) => void open(url).catch(() => {});
/** Show a file in Finder / Explorer. */
export const reveal = (path: string) => void revealItemInDir(path).catch(() => {});
