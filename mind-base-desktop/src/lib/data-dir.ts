/**
 * Typed access to the relocatable data directory
 * (exposed by the Rust `get_data_dir` / `set_data_dir` / `reset_data_dir`
 * commands).
 *
 * The SQLite database always lives under the *active* data directory. A
 * pointer file inside the OS-default directory names a custom location, so
 * relocation survives restarts without the config itself being readable yet
 * (bootstrap problem: the pointer must not live inside the database).
 */

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/** Placement snapshot describing the active data directory. */
export interface DataDirInfo {
  /** Directory currently hosting the database file. */
  currentPath: string;
  /** True when the active directory differs from the OS default. */
  isCustom: boolean;
  /** OS-default app-data directory (pointer anchor / reset target). */
  defaultPath: string;
}

/** Fetch the current data-directory placement. */
export async function getDataDir(): Promise<DataDirInfo> {
  return invoke<DataDirInfo>("get_data_dir");
}

/**
 * Switch the data directory to `path`.
 *
 * `migrate=true` copies the existing database files to the new location;
 * `migrate=false` starts a fresh empty database there (old files stay put,
 * so either way the operation is reversible by switching back).
 */
export async function setDataDir(path: string, migrate: boolean): Promise<DataDirInfo> {
  return invoke<DataDirInfo>("set_data_dir", { path, migrate });
}

/** Move back to the OS-default directory (same `migrate` semantics). */
export async function resetDataDir(migrate: boolean): Promise<DataDirInfo> {
  return invoke<DataDirInfo>("reset_data_dir", { migrate });
}

/**
 * Open the native folder picker; resolves to `null` when the user cancels.
 */
export async function pickDirectory(title: string): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false, title });
  return typeof selected === "string" && selected.length > 0 ? selected : null;
}
