//! User-facing workspace domains (one package per document kind).
//!
//! - [`notes`] — markdown notebook, revisions and Bilibili anchors.
//! - [`quiz`] — quiz generation/grading and saved quiz sets.
//! - [`mindmap`] — mind maps, snapshots, templates and icon packs.
//! - [`research`] — academic research projects and stage guidance.
//! - [`manuscript`] — manuscript sections + docx export.
//! - [`literature`] — reference library (BibTeX/CSL, Crossref verification).
//! - [`dataset`] — dataset import and analysis runs.
//! - [`resume`] — resume/exports listing.
//! - [`slides`] — slide outlines and export.

pub(crate) mod dataset;
pub(crate) mod literature;
pub(crate) mod manuscript;
pub(crate) mod mindmap;
pub(crate) mod notes;
pub(crate) mod quiz;
pub(crate) mod research;
pub(crate) mod resume;
pub(crate) mod slides;
