//! On-disk skill layout: skills root, SKILL.md discovery.

use std::path::{Path, PathBuf};

const SKILLS_DIR_NAME: &str = "skills";
pub(super) const SKILL_FILE: &str = "SKILL.md";
pub(super) const SAMPLE_DIR_NAME: &str = "example-note-taking";

/// Skills directory under the active data dir.
pub(super) fn skills_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(SKILLS_DIR_NAME)
}

/// Locate the skill file of one installed folder: `<folder>/SKILL.md` first;
/// when absent (legacy installs of GitHub zipballs kept their inner prefix
/// dir, and multi-skill collection repos nest deeply), fall back to the
/// *shortest-path* SKILL.md anywhere inside — mirroring the backend's
/// `_find_entry` semantics. Bounded walk (dirs cap) so a hostile tree can't
/// spin the scan.
pub(super) fn find_skill_file(folder_dir: &Path) -> Option<PathBuf> {
    const MAX_DIRS: usize = 500;
    let mut best: Option<PathBuf> = None;
    let mut stack = vec![folder_dir.to_path_buf()];
    let mut visited = 0usize;
    while let Some(current) = stack.pop() {
        visited += 1;
        if visited > MAX_DIRS {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.file_name().map(|n| n == SKILL_FILE).unwrap_or(false)
                && best.as_ref().map_or(true, |best| {
                    path.components().count() < best.components().count()
                })
            {
                best = Some(path);
            }
        }
    }
    best
}
