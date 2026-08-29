/**
 * Typed access to the local skills feature (Rust `skills_*` commands).
 *
 * Skills are SKILL.md packs under `<data dir>/skills/<folder>/` — drop a
 * folder in and it is discovered on the next scan (no restart). The chat
 * agent sees only name+description in its system prompt and pulls the full
 * body via the `load_skill` tool when relevant.
 */

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/** Non-secret view of one discovered skill. */
export interface SkillMeta {
  /** Frontmatter name (falls back to the folder name). */
  name: string;
  description: string;
  enabled: boolean;
  /** Folder name on disk — the identity `load_skill` accepts. */
  folder: string;
}

/** Snapshot every discovered skill with its persisted enabled flag. */
export function listSkills(): Promise<SkillMeta[]> {
  return invoke<SkillMeta[]>("skills_list");
}

/** Enable/disable one skill (persisted by folder name). */
export function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  return invoke<void>("skills_set_enabled", { name, enabled });
}

/**
 * Create the skills dir (seeding a sample skill when empty) and reveal it
 * in the OS file manager; resolves with the directory path.
 */
export function openSkillsDir(): Promise<string> {
  return invoke<string>("skills_open_dir");
}

/**
 * Install a skill from a local folder (must contain SKILL.md); the folder is
 * deep-copied into `<data dir>/skills/<folder>/`. Rejects when the target
 * folder name already exists.
 */
export function installSkillFromPath(source: string): Promise<SkillMeta> {
  return invoke<SkillMeta>("skills_install_from_path", { source });
}

/**
 * Pick a skill-pack zip (same archive format as the app/ skill store:
 * SKILL.md + optional manifest.json, GitHub-zipball layout tolerated) and
 * install it. Resolves null when the user cancels the picker.
 */
export async function installSkillZip(): Promise<SkillMeta | null> {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "技能包", extensions: ["zip"] }],
  });
  if (picked === null || Array.isArray(picked) || picked === "") return null;
  return invoke<SkillMeta>("skills_install_zip", { path: picked });
}

/** One GitHub repository returned by the store search (backend parity). */
export interface StoreRepo {
  fullName: string;
  description: string;
  stargazersCount: number;
  defaultBranch: string;
  htmlUrl: string;
}

/**
 * Search GitHub repositories for installable skills; empty query falls back
 * to the `mindbase-skill` topic (same protocol as app/skills/store).
 */
export function searchStore(query: string | null): Promise<StoreRepo[]> {
  return invoke<StoreRepo[]>("skills_store_search", { query });
}

/**
 * Install a skill pack straight from GitHub (`owner/repo`, empty branch =
 * repo default) by downloading the zipball into the skills dir.
 */
export function installFromStore(repo: string, branch: string | null): Promise<SkillMeta> {
  return invoke<SkillMeta>("skills_store_install", { repo, branch: branch ?? null });
}

/** Uninstall one skill: delete its folder and drop the persisted flag. */
export function uninstallSkill(folder: string): Promise<void> {
  return invoke<void>("skills_uninstall", { folder });
}
