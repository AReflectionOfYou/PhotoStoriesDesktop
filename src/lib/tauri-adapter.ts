// photostories-core's FileAdapter, backed by the app's Rust commands. Paths
// are absolute. Large files are hashed, copied and zipped in Rust, so photo
// bytes only cross into the window when they are actually needed.

import { invoke } from "@tauri-apps/api/core";
import type { DirEntry, FileAdapter } from "photostories-core";

export class TauriAdapter implements FileAdapter {
  async readFile(path: string) {
    return new Uint8Array(await invoke<ArrayBuffer>("read_file", { path }));
  }
  async writeFile(path: string, data: Uint8Array) {
    await invoke("write_file", data, { headers: { "x-path": encodeURIComponent(path) } });
  }
  list(path: string) {
    return invoke<DirEntry[]>("list_dir", { path });
  }
  exists(path: string) {
    return invoke<boolean>("exists", { path });
  }
  mkdir(path: string) {
    return invoke<void>("mkdir", { path });
  }
  remove(path: string) {
    return invoke<void>("remove", { path });
  }
  size(path: string) {
    return invoke<number>("size", { path });
  }
  sha256(path: string) {
    return invoke<string>("sha256", { path });
  }
  copyFile(from: string, to: string) {
    return invoke<void>("copy_file", { from, to });
  }
  zipDir(dir: string, zipPath: string) {
    return invoke<void>("zip_dir", { dir, zipPath });
  }
  unzip(zipPath: string, dir: string) {
    return invoke<void>("unzip", { zipPath, dir });
  }
}

export const fs = new TauriAdapter();
