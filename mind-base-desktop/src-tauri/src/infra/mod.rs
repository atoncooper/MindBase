//! Local infrastructure layer.
//!
//! Nothing here knows about agents, UI domains or HTTP APIs: these are the
//! primitives every other package builds on.
//!
//! - [`db`] — SQLite connection, schema/migrations and the data-directory
//!   relocation protocol.
//! - [`config`] — user-facing settings persisted in SQLite.
//! - [`logging`] — rotating file logger under the data directory.
//! - [`store`] — conversation/turn artifacts on disk (index, spans, errors).
//! - [`python_runtime`] — embedded Python provisioning for local sidecars.
//! - [`updater`] — signed self-update (check, download, install).

pub(crate) mod config;
pub(crate) mod db;
pub(crate) mod exec_log;
pub(crate) mod usage;
pub(crate) mod logging;
pub(crate) mod python_runtime;
pub(crate) mod store;
pub(crate) mod updater;
