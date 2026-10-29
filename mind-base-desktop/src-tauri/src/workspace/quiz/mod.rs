//! Quiz engine — manual knowledge quizzes over the local vector store.
//!
//! Desktop adaptation of app/agent/quiz: same four question types, the same
//! validation constants and the essay→short_answer→single_choice downgrade
//! chain, but generation uses strict-JSON prompting instead of LangChain
//! structured output (no Python runtime here). Objective types are graded
//! locally; essays are scored by the LLM against the rubric.
//!
//! Module layout:
//! - [`types`] — DTOs (`QuizQuestion`, `QuizSet`, request/result payloads) + caps.
//! - [`parse`] — raw model reply → [`QuizQuestion`] normalization.
//! - [`history`] — `quiz_history` dedup / avoid-list.
//! - [`generate`] — chunk sampling, prompt, batch generation with downgrade.
//! - [`grade`] — objective + keyword + LLM-rubric grading.
//! - [`commands`] — `quiz_source_chunks` / `quiz_generate` / `quiz_grade`.
//! - [`sets`] — `quiz_set_*` persisted-set commands.

mod commands;
mod generate;
mod grade;
mod history;
mod parse;
mod sets;
mod types;
#[cfg(test)]
mod tests;

// Path stability: the old flat `quiz.rs` exposed these directly from this module, so the
// submodules re-export them here. Nothing outside the package reads the DTOs/helpers yet,
// hence the `unused_imports` allowance on the two path-stability groups.
#[allow(unused_imports)]
pub use types::{
    GradeOutcome, KnowledgeChunk, QuizGenEvent, QuizGenerateRequest, QuizGenerateResult,
    QuizQuestion, QuizRecordItem, QuizSet, QuizSetCreateRequest, QuizSetMeta, RubricItem,
};
#[allow(unused_imports)]
pub(crate) use {
    generate::{fetch_chunks, generate_batch, BatchResult},
    grade::grade_question,
    history::question_hash,
    parse::{normalize_question, parse_questions_reply},
    types::{DIFFICULTIES, MAX_QUESTIONS, TYPE_ESSAY, TYPE_MULTI, TYPE_SHORT, TYPE_SINGLE},
};

pub(crate) use commands::{quiz_generate, quiz_grade, quiz_source_chunks};
pub(crate) use sets::{
    quiz_set_create, quiz_set_delete, quiz_set_finish, quiz_set_get, quiz_set_list,
    quiz_set_save_answers,
};

// `#[tauri::command]` emits hidden `__cmd__*` / `__tauri_command_name_*` macros next to each
// command. `app/commands.rs` registers the commands through this module path, so both macros
// have to be re-exported alongside the functions they belong to.
#[doc(hidden)]
pub(crate) use commands::{
    __cmd__quiz_generate, __cmd__quiz_grade, __cmd__quiz_source_chunks,
    __tauri_command_name_quiz_generate, __tauri_command_name_quiz_grade,
    __tauri_command_name_quiz_source_chunks,
};
#[doc(hidden)]
pub(crate) use sets::{
    __cmd__quiz_set_create, __cmd__quiz_set_delete, __cmd__quiz_set_finish, __cmd__quiz_set_get,
    __cmd__quiz_set_list, __cmd__quiz_set_save_answers, __tauri_command_name_quiz_set_create,
    __tauri_command_name_quiz_set_delete, __tauri_command_name_quiz_set_finish,
    __tauri_command_name_quiz_set_get, __tauri_command_name_quiz_set_list,
    __tauri_command_name_quiz_set_save_answers,
};
