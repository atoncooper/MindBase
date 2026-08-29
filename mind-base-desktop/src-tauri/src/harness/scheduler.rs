//! AgentScheduler — per-agent queue slots with concurrency limits and
//! classified retry/backoff. Desktop counterpart of
//! app/harness/scheduling/agent/scheduler.py.
//!
//! Faithful posture: production traffic bypasses the scheduler (both backend
//! and desktop invoke agents directly), so this exists as real,
//! test-consumed scaffolding. Each agent slot owns a bounded FIFO
//! (`sync_channel(max_queue)`) drained by `max_concurrent` worker threads;
//! failures classified retryable get exponential backoff up to `max_retries`.

use std::collections::HashMap;
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Slot configuration (frozen defaults mirror the backend's AgentConfig).
#[derive(Debug, Clone)]
pub(crate) struct SchedulerConfig {
    pub max_concurrent: usize,
    pub max_queue: usize,
    pub max_retries: u32,
    pub backoff_base_ms: u64,
    pub backoff_max_ms: u64,
}

impl SchedulerConfig {
    #[cfg(test)]
    pub(crate) fn with_retries(max_retries: u32) -> Self {
        Self { max_retries, ..Self::default() }
    }
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            max_concurrent: 1,
            max_queue: 50,
            max_retries: 2,
            backoff_base_ms: 1000,
            backoff_max_ms: 30_000,
        }
    }
}

/// Error classification mirroring app/agent/errors.py substring lists:
/// transport-ish failures retry, authentication-style failures never do.
fn classify_error(message: &str) -> bool {
    const RETRYABLE: [&str; 8] = [
        "timeout", "timed out", "connection", "rate limit", "503", "502", "500", "temporarily",
    ];
    const FATAL: [&str; 4] =
        ["authentication", "unauthorized", "invalid api key", "permission denied"];
    let lowered = message.to_lowercase();
    if FATAL.iter().any(|pattern| lowered.contains(pattern)) {
        return false;
    }
    RETRYABLE.iter().any(|pattern| lowered.contains(pattern))
}

fn backoff_delay(attempt: u32, base_ms: u64, max_ms: u64) -> Duration {
    let delay = base_ms.saturating_mul(1u64 << attempt.min(20));
    Duration::from_millis(delay.min(max_ms))
}

struct SlotHandle {
    job_tx: SyncSender<Box<dyn FnOnce() + Send>>,
}

/// Per-agent queue slots, lazily created on first submit.
#[derive(Default)]
pub(crate) struct AgentScheduler {
    slots: Mutex<HashMap<String, SlotHandle>>,
    config: SchedulerConfig,
}

impl AgentScheduler {
    pub(crate) fn new(config: SchedulerConfig) -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
            config,
        }
    }

    /// Queue one job against an agent's slot. A full queue mirrors the
    /// backend message verbatim (`queue full, try again later`) instead of
    /// blocking the caller. The job's outcome arrives on the returned
    /// receiver; with retries enabled the receiver stays silent until a
    /// non-retryable result (success or final failure) is reached.
    pub(crate) fn submit<F>(
        &self,
        agent_name: &str,
        mut work: F,
    ) -> Result<Receiver<Result<String, String>>, String>
    where
        F: FnMut() -> Result<String, String> + Send + 'static,
    {
        let job_tx = self.ensure_slot(agent_name)?;
        let config = self.config.clone();
        let (result_tx, result_rx) = sync_channel(1);
        job_tx
            .try_send(Box::new(move || {
                let mut attempt = 0u32;
                loop {
                    match work() {
                        Ok(outcome) => {
                            let _ = result_tx.send(Ok(outcome));
                            break;
                        }
                        Err(error) => {
                            attempt += 1;
                            if attempt > config.max_retries || !classify_error(&error) {
                                let _ = result_tx.send(Err(error));
                                break;
                            }
                            std::thread::sleep(backoff_delay(
                                attempt - 1,
                                config.backoff_base_ms,
                                config.backoff_max_ms,
                            ));
                        }
                    }
                }
            }))
            .map_err(|_| "queue full, try again later".to_string())?;
        Ok(result_rx)
    }

    /// Number of live agent slots (observability).
    pub(crate) fn slot_count(&self) -> usize {
        self.slots.lock().expect("scheduler mutex poisoned").len()
    }

    fn ensure_slot(
        &self,
        agent_name: &str,
    ) -> Result<SyncSender<Box<dyn FnOnce() + Send>>, String> {
        let mut slots = self.slots.lock().expect("scheduler mutex poisoned");
        if let Some(handle) = slots.get(agent_name) {
            return Ok(handle.job_tx.clone());
        }
        let config = self.config.clone();
        let (job_tx, job_rx): (_, Receiver<Box<dyn FnOnce() + Send>>) =
            sync_channel(config.max_queue);
        // mpsc Receivers are single-consumer; N workers share one behind a
        // mutex (jobs are long-lived, so contention is negligible).
        let shared_rx = Arc::new(Mutex::new(job_rx));

        // `max_concurrent` workers drain one FIFO — the direct analogue of
        // the backend's semaphore-plus-worker-task pair.
        for _ in 0..config.max_concurrent.max(1) {
            let rx = Arc::clone(&shared_rx);
            std::thread::spawn(move || loop {
                let job = {
                    let guard = rx.lock().expect("scheduler queue mutex poisoned");
                    guard.recv()
                };
                match job {
                    Ok(job) => job(),
                    Err(_) => break, // channel closed: slot shutting down
                }
            });
        }

        slots.insert(agent_name.to_string(), SlotHandle { job_tx });
        Ok(slots
            .get(agent_name)
            .expect("inserted above")
            .job_tx
            .clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[test]
    fn error_classification_matches_backend_lists() {
        assert!(classify_error("request timed out after 30s"));
        assert!(classify_error("HTTP 503 service unavailable"));
        assert!(classify_error("rate limited by provider"));
        assert!(classify_error("connection reset"));
        assert!(!classify_error("invalid api key provided"));
        assert!(!classify_error("permission denied"));
        assert!(!classify_error("something odd happened"));
    }

    #[test]
    fn backoff_grows_exponentially_and_caps() {
        assert_eq!(backoff_delay(0, 1000, 30_000), Duration::from_millis(1000));
        assert_eq!(backoff_delay(1, 1000, 30_000), Duration::from_millis(2000));
        assert_eq!(backoff_delay(2, 1000, 30_000), Duration::from_millis(4000));
        assert_eq!(backoff_delay(10, 1000, 30_000), Duration::from_millis(30_000));
    }

    #[test]
    fn jobs_execute_through_the_worker_with_retries() {
        let scheduler = AgentScheduler::new(SchedulerConfig::with_retries(2));
        let attempts = Arc::new(AtomicU32::new(0));
        let counter = Arc::clone(&attempts);

        let rx = scheduler
            .submit("quiz", move || {
                if counter.fetch_add(1, Ordering::SeqCst) < 2 {
                    Err(String::from("transient timeout"))
                } else {
                    Ok(String::from("done"))
                }
            })
            .expect("submit");

        let result = rx.recv().expect("worker reply");
        assert_eq!(result.unwrap(), "done");
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn fatal_errors_skip_retry_entirely() {
        let scheduler = AgentScheduler::new(SchedulerConfig::with_retries(3));
        let attempts = Arc::new(AtomicU32::new(0));
        let counter = Arc::clone(&attempts);

        let rx = scheduler
            .submit("chat", move || {
                counter.fetch_add(1, Ordering::SeqCst);
                Err(String::from("authentication failed"))
            })
            .expect("submit");

        let result = rx.recv().expect("worker reply");
        assert!(result.is_err());
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn max_concurrent_one_serializes_same_agent_jobs() {
        let scheduler = Arc::new(AgentScheduler::new(SchedulerConfig {
            max_concurrent: 1,
            ..SchedulerConfig::default()
        }));
        let timeline = Arc::new(Mutex::new(Vec::<(&'static str, Instant, Instant)>::new()));

        let handles: Vec<_> = ["a", "b"]
            .iter()
            .map(|label| {
                let label = *label;
                let timeline = Arc::clone(&timeline);
                let scheduler = Arc::clone(&scheduler);
                std::thread::spawn(move || {
                    let rx = scheduler
                        .submit("solo", move || {
                            let start = Instant::now();
                            std::thread::sleep(Duration::from_millis(60));
                            let end = Instant::now();
                            timeline.lock().unwrap().push((label, start, end));
                            Ok(label.to_string())
                        })
                        .expect("submit");
                    rx.recv().unwrap().unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        let timeline = timeline.lock().unwrap();
        assert_eq!(timeline.len(), 2);
        let (first_end, second_start) = if timeline[0].1 <= timeline[1].1 {
            (timeline[0].2, timeline[1].1)
        } else {
            (timeline[1].2, timeline[0].1)
        };
        assert!(
            second_start >= first_end,
            "max_concurrent=1 must serialize same-agent jobs"
        );
    }
}
