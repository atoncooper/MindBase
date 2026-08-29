//! Agent lifecycle — circuit breakers, session registry with TTL cleanup and
//! per-session locks. Desktop counterpart of app/agent/lifecycle/*.
//!
//! Faithful constants: breaker trips after 3 consecutive failures and
//! auto-half-opens after a 30 s cooldown; sessions expire after 600 s of
//! idleness, swept every 120 s.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub(crate) const BREAKER_FAILURE_THRESHOLD: u32 = 3;
pub(crate) const BREAKER_COOLDOWN_SECS: u64 = 30;
pub(crate) const SESSION_TTL_SECS: u64 = 600;
pub(crate) const CLEANUP_INTERVAL_SECS: u64 = 120;

/// Backend message used verbatim when an agent's breaker is open.
pub(crate) const BREAKER_OPEN_MESSAGE: &str = "service temporarily unavailable";

/// Three-state breaker (CLOSED → OPEN → HALF_OPEN → CLOSED …).
#[derive(Debug)]
pub(crate) struct CircuitBreaker {
    failure_threshold: u32,
    cooldown: Duration,
    failures: u32,
    opened_at: Option<Instant>,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum CircuitState {
    Closed,
    Open,
    HalfOpen,
}

impl Default for CircuitBreaker {
    fn default() -> Self {
        Self {
            failure_threshold: BREAKER_FAILURE_THRESHOLD,
            cooldown: Duration::from_secs(BREAKER_COOLDOWN_SECS),
            failures: 0,
            opened_at: None,
        }
    }
}

impl CircuitBreaker {
    pub(crate) fn state(&self) -> CircuitState {
        match self.opened_at {
            Some(at) if at.elapsed() < self.cooldown => CircuitState::Open,
            Some(_) => CircuitState::HalfOpen,
            None => CircuitState::Closed,
        }
    }

    /// True only while hard-open (calls are rejected in this state; HALF_OPEN
    /// lets one trial through).
    pub(crate) fn is_tripped(&self) -> bool {
        self.state() == CircuitState::Open
    }

    pub(crate) fn record_success(&mut self) {
        self.failures = 0;
        self.opened_at = None;
    }

    /// Record a failure; returns true when this call tripped the breaker.
    /// A failed HALF_OPEN probe re-opens with a fresh cooldown.
    pub(crate) fn record_failure(&mut self) -> bool {
        let was_half_open = self.state() == CircuitState::HalfOpen;
        self.failures += 1;
        if was_half_open
            || (self.failures >= self.failure_threshold && self.opened_at.is_none())
        {
            self.opened_at = Some(Instant::now());
            return true;
        }
        false
    }

    pub(crate) fn failure_count(&self) -> u32 {
        self.failures
    }
}

/// One chat-session's lifecycle bookkeeping.
pub(crate) struct SessionEntry {
    pub last_active: Instant,
    pub lock: Arc<Mutex<()>>,
    /// Per-agent consecutive delegate failure counts (chat-side short-circuit).
    pub delegate_failures: HashMap<String, u32>,
    /// Memory-agent retrieval window (30 entries max, newest last).
    pub memory_window: Vec<crate::agents::SearchWindowEntry>,
}

impl Default for SessionEntry {
    fn default() -> Self {
        Self {
            last_active: Instant::now(),
            lock: Arc::new(Mutex::new(())),
            delegate_failures: HashMap::new(),
            memory_window: Vec::new(),
        }
    }
}

const MEMORY_WINDOW_MAX: usize = 30;

impl SessionEntry {
    pub(crate) fn touch(&mut self) {
        self.last_active = Instant::now();
    }

    pub(crate) fn push_memory_window(&mut self, entry: crate::agents::SearchWindowEntry) {
        self.memory_window.push(entry);
        if self.memory_window.len() > MEMORY_WINDOW_MAX {
            let overflow = self.memory_window.len() - MEMORY_WINDOW_MAX;
            self.memory_window.drain(0..overflow);
        }
    }
}

/// Sessions + per-agent-type breakers, globally shared via [`super::harness_state`].
#[derive(Default)]
pub(crate) struct LifecycleManager {
    inner: Mutex<LifecycleInner>,
}

#[derive(Default)]
struct LifecycleInner {
    sessions: HashMap<String, SessionEntry>,
    breakers: HashMap<String, CircuitBreaker>,
}

/// Owned gate returned by [`LifecycleManager::enter`]: whether the breaker
/// rejects calls plus the session's turn lock to acquire.
pub(crate) struct SessionGate {
    pub breaker_tripped: bool,
    pub session_lock: Arc<Mutex<()>>,
}

impl LifecycleManager {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Resolve (or create) everything one agent invocation needs, reporting
    /// whether the breaker currently rejects calls.
    pub(crate) fn enter(&self, agent_name: &str, session_id: &str) -> SessionGate {
        let mut inner = self.inner.lock().expect("lifecycle mutex poisoned");
        let breaker = inner.breakers.entry(agent_name.to_string()).or_default();
        let tripped = breaker.is_tripped();
        let session = inner
            .sessions
            .entry(session_id.to_string())
            .or_default();
        session.touch();
        SessionGate {
            breaker_tripped: tripped,
            session_lock: session.lock.clone(),
        }
    }

    pub(crate) fn record_success(&self, agent_name: &str, session_id: &str) {
        let mut inner = self.inner.lock().expect("lifecycle mutex poisoned");
        if let Some(breaker) = inner.breakers.get_mut(agent_name) {
            breaker.record_success();
        }
        if let Some(session) = inner.sessions.get_mut(session_id) {
            session.touch();
        }
    }

    pub(crate) fn record_failure(&self, agent_name: &str, session_id: &str) {
        let mut inner = self.inner.lock().expect("lifecycle mutex poisoned");
        if let Some(breaker) = inner.breakers.get_mut(agent_name) {
            breaker.record_failure();
        }
        if let Some(session) = inner.sessions.get_mut(session_id) {
            session.touch();
        }
    }

    /// Delegate short-circuit counter for `(session, agent)`; returns the new
    /// consecutive-failure count after recording one failure.
    pub(crate) fn bump_delegate_failure(&self, session_id: &str, agent_name: &str) -> u32 {
        let mut inner = self.inner.lock().expect("lifecycle mutex poisoned");
        let session = inner
            .sessions
            .entry(session_id.to_string())
            .or_default();
        let count = session.delegate_failures.entry(agent_name.to_string()).or_insert(0);
        *count += 1;
        *count
    }

    pub(crate) fn reset_delegate_failures(&self, session_id: &str, agent_name: &str) {
        let mut inner = self.inner.lock().expect("lifecycle mutex poisoned");
        if let Some(session) = inner.sessions.get_mut(session_id) {
            session.delegate_failures.remove(agent_name);
        }
    }

    /// Per-agent breaker snapshot for the health view.
    pub(crate) fn breaker_snapshot(&self) -> Vec<(String, crate::harness::lifecycle::CircuitState, u32)> {
        self.inner
            .lock()
            .expect("lifecycle mutex poisoned")
            .breakers
            .iter()
            .map(|(name, breaker)| (name.clone(), breaker.state(), breaker.failure_count()))
            .collect()
    }

    /// Snapshot of the memory retrieval window for one session.
    pub(crate) fn memory_window(
        &self,
        session_id: &str,
    ) -> Vec<crate::agents::SearchWindowEntry> {
        self.inner
            .lock()
            .expect("lifecycle mutex poisoned")
            .sessions
            .get(session_id)
            .map(|session| session.memory_window.clone())
            .unwrap_or_default()
    }

    pub(crate) fn append_memory_window(
        &self,
        session_id: &str,
        entry: crate::agents::SearchWindowEntry,
    ) {
        let mut inner = self.inner.lock().expect("lifecycle mutex poisoned");
        inner
            .sessions
            .entry(session_id.to_string())
            .or_default()
            .push_memory_window(entry);
    }

    /// Drop idle sessions; returns how many were removed.
    pub(crate) fn cleanup_expired(&self, ttl: Duration) -> usize {
        let mut inner = self.inner.lock().expect("lifecycle mutex poisoned");
        let before = inner.sessions.len();
        inner
            .sessions
            .retain(|_, session| session.last_active.elapsed() < ttl);
        before - inner.sessions.len()
    }

    pub(crate) fn active_sessions(&self) -> usize {
        self.inner.lock().expect("lifecycle mutex poisoned").sessions.len()
    }
}

/// Spawn the periodic TTL sweep (mirrors harness.start()'s cleanup loop).
pub(crate) fn spawn_cleanup_thread(manager: &std::sync::Arc<LifecycleManager>) {
    let manager = std::sync::Arc::clone(manager);
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(CLEANUP_INTERVAL_SECS));
        manager.cleanup_expired(Duration::from_secs(SESSION_TTL_SECS));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn breaker_transitions_through_three_states() {
        let mut breaker = CircuitBreaker::default();
        assert_eq!(breaker.state(), CircuitState::Closed);

        // Two failures keep it closed.
        assert!(!breaker.record_failure());
        assert!(!breaker.record_failure());
        assert_eq!(breaker.state(), CircuitState::Closed);

        // Third consecutive failure trips it.
        assert!(breaker.record_failure());
        assert_eq!(breaker.state(), CircuitState::Open);
        assert!(breaker.is_tripped());

        // Cooldown elapsed → half-open allows a trial call.
        breaker.cooldown = Duration::from_millis(30);
        std::thread::sleep(Duration::from_millis(40));
        assert_eq!(breaker.state(), CircuitState::HalfOpen);
        assert!(!breaker.is_tripped());

        // A failed probe re-opens with a fresh cooldown…
        assert!(breaker.record_failure());
        assert_eq!(breaker.state(), CircuitState::Open);

        // …and a success after the new cooldown closes and clears counts.
        std::thread::sleep(Duration::from_millis(40));
        breaker.record_success();
        assert_eq!(breaker.state(), CircuitState::Closed);
        assert_eq!(breaker.failure_count(), 0);
    }

    #[test]
    fn failed_half_open_probe_reopens() {
        let mut breaker = CircuitBreaker::default();
        for _ in 0..BREAKER_FAILURE_THRESHOLD {
            breaker.record_failure();
        }
        assert_eq!(breaker.state(), CircuitState::Open);
        // Cooldown elapses → HALF_OPEN admits a probe…
        breaker.cooldown = Duration::from_millis(20);
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(breaker.state(), CircuitState::HalfOpen);
        // …and a failed probe re-opens with a fresh cooldown window.
        assert!(breaker.record_failure());
        assert_eq!(breaker.state(), CircuitState::Open);
        assert!(breaker.is_tripped());
    }

    #[test]
    fn session_lifecycle_tracks_locks_windows_and_expiry() {
        let manager = LifecycleManager::new();
        {
            let gate = manager.enter("chat", "s1");
            assert!(!gate.breaker_tripped);
        }
        manager.append_memory_window("s1", crate::agents::SearchWindowEntry {
            query: "q".into(),
            result_preview: "r".into(),
            tools_used: vec!["vector_search".into()],
            timestamp: "12:00".into(),
        });
        assert_eq!(manager.memory_window("s1").len(), 1);

        // The turn lock is stable across enters for the same session…
        let first_ptr = { manager.enter("memory", "s1").session_lock.clone() };
        let second_ptr = manager.enter("chat", "s1").session_lock.clone();
        assert!(Arc::ptr_eq(&first_ptr, &second_ptr));

        assert_eq!(manager.active_sessions(), 1);

        // TTL sweep drops idle sessions.
        assert_eq!(
            manager.cleanup_expired(Duration::from_secs(SESSION_TTL_SECS)),
            0,
            "fresh session survives"
        );
        {
            let mut inner = manager.inner.lock().unwrap();
            if let Some(session) = inner.sessions.get_mut("s1") {
                session.last_active = Instant::now() - Duration::from_secs(SESSION_TTL_SECS + 10);
            }
        }
        assert_eq!(manager.cleanup_expired(Duration::from_secs(SESSION_TTL_SECS)), 1);
        assert_eq!(manager.active_sessions(), 0);
    }

    #[test]
    fn delegate_failure_counts_are_per_session_and_agent() {
        let manager = LifecycleManager::new();
        assert_eq!(manager.bump_delegate_failure("s1", "memory"), 1);
        assert_eq!(manager.bump_delegate_failure("s1", "memory"), 2);
        assert_eq!(manager.bump_delegate_failure("s2", "memory"), 1, "other session isolated");
        assert_eq!(manager.bump_delegate_failure("s1", "note"), 1, "other agent isolated");
        manager.reset_delegate_failures("s1", "memory");
        assert_eq!(manager.bump_delegate_failure("s1", "memory"), 1);
    }
}
