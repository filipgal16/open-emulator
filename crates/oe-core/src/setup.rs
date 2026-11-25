//! First-run setup: steps that check themselves, and repair what they can without being asked.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use oe_engine::LogHandler;

use crate::{err, Result};

pub type StepFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
pub type Check = Arc<dyn Fn() -> StepFuture<Result<CheckResult>> + Send + Sync>;
pub type Fix = Arc<dyn Fn(LogHandler) -> StepFuture<Result<()>> + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckResult {
    pub pass: bool,
    /// A failure that is not one: the step works, just not as well as it could.
    pub warn: bool,
    pub detail: String,
}

impl CheckResult {
    pub fn pass(detail: impl Into<String>) -> CheckResult {
        CheckResult { pass: true, warn: false, detail: detail.into() }
    }

    pub fn fail(detail: impl Into<String>) -> CheckResult {
        CheckResult { pass: false, warn: false, detail: detail.into() }
    }

    pub fn warn(detail: impl Into<String>) -> CheckResult {
        CheckResult { pass: false, warn: true, detail: detail.into() }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepState {
    Pending,
    Running,
    Pass,
    Fail,
    Warn,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupStepStatus {
    pub id: String,
    pub label: String,
    pub status: StepState,
    pub detail: String,
    pub blocking: bool,
}

pub struct Step {
    pub id: &'static str,
    pub label: &'static str,
    /// A blocking step must pass before setup can hand the user into the app.
    pub blocking: bool,
    /// Shown while the fix runs. Plain language, and honest about how long it will take.
    pub working: Option<&'static str>,
    /// Not run by [`SetupRunner::run_auto`], even when its check fails: for work that must not gate
    /// the wizard, provisioning's one-time cold boot, which the caller starts in the background.
    /// [`SetupRunner::run_fix`] still runs it on demand.
    pub defer_fix: bool,
    pub check: Check,
    pub fix: Option<Fix>,
}

impl Step {
    fn status(&self, status: StepState, detail: impl Into<String>) -> SetupStepStatus {
        SetupStepStatus {
            id: self.id.to_owned(),
            label: self.label.to_owned(),
            status,
            detail: detail.into(),
            blocking: self.blocking,
        }
    }

    async fn run_check(&self) -> SetupStepStatus {
        match (self.check)().await {
            Ok(result) => {
                let state = match (result.pass, result.warn) {
                    (true, _) => StepState::Pass,
                    (false, true) => StepState::Warn,
                    (false, false) => StepState::Fail,
                };
                self.status(state, result.detail)
            }
            Err(error) => self.status(StepState::Fail, error.0),
        }
    }
}

pub struct SetupRunner {
    steps: Vec<Step>,
}

impl SetupRunner {
    pub fn new(steps: Vec<Step>) -> SetupRunner {
        SetupRunner { steps }
    }

    pub fn steps(&self) -> &[Step] {
        &self.steps
    }

    pub fn list(&self) -> Vec<SetupStepStatus> {
        self.steps.iter().map(|step| step.status(StepState::Pending, "")).collect()
    }

    /// Checks every step, repairing nothing.
    pub async fn run_all(&self, emit: impl Fn(&SetupStepStatus)) -> Vec<SetupStepStatus> {
        let mut results = Vec::new();
        for step in &self.steps {
            emit(&step.status(StepState::Running, ""));
            let status = step.run_check().await;
            emit(&status);
            results.push(status);
        }
        results
    }

    /// Checks every step and repairs what it can, without being asked. The first-run path.
    ///
    /// A failing blocking step stops the run rather than letting the rest fail after it.
    /// Everything downstream depends on it, and a cascade of red rows buries the one cause worth
    /// reading.
    pub async fn run_auto(&self, emit: impl Fn(&SetupStepStatus), on_log: LogHandler) -> Vec<SetupStepStatus> {
        let mut results = Vec::new();
        for step in &self.steps {
            emit(&step.status(StepState::Running, "Checking…"));
            let mut status = step.run_check().await;

            if status.status == StepState::Fail && !step.defer_fix {
                if let Some(fix) = &step.fix {
                    emit(&step.status(StepState::Running, step.working.unwrap_or("Working…")));
                    status = match fix(on_log.clone()).await {
                        Ok(()) => step.run_check().await,
                        Err(error) => step.status(StepState::Fail, error.0),
                    };
                }
            }

            emit(&status);
            let stop = status.status == StepState::Fail && step.blocking;
            results.push(status);
            if stop {
                break;
            }
        }
        results
    }

    /// Runs one step's fix on demand, then checks it again.
    pub async fn run_fix(&self, id: &str, on_log: LogHandler, emit: impl Fn(&SetupStepStatus)) -> Result<SetupStepStatus> {
        let step = self.steps.iter().find(|step| step.id == id).ok_or_else(|| err!("unknown setup step: {id}"))?;
        let fix = step.fix.as_ref().ok_or_else(|| err!("step \"{id}\" has no automated fix"))?;

        emit(&step.status(StepState::Running, "applying fix…"));
        let status = match fix(on_log).await {
            Ok(()) => step.run_check().await,
            Err(error) => step.status(StepState::Fail, error.0),
        };
        emit(&status);
        Ok(status)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Mutex;

    use oe_engine::no_log;

    use super::*;

    /// A step whose check passes once its fix has run.
    fn fixable(id: &'static str, blocking: bool, defer_fix: bool, fixed: Arc<AtomicBool>, fixes: Arc<AtomicU32>) -> Step {
        let seen = fixed.clone();
        Step {
            id,
            label: id,
            blocking,
            working: Some("working on it"),
            defer_fix,
            check: Arc::new(move || {
                let pass = seen.load(Ordering::SeqCst);
                Box::pin(async move { Ok(if pass { CheckResult::pass("fine") } else { CheckResult::fail("broken") }) })
            }),
            fix: Some(Arc::new(move |_| {
                let (fixed, fixes) = (fixed.clone(), fixes.clone());
                Box::pin(async move {
                    fixes.fetch_add(1, Ordering::SeqCst);
                    fixed.store(true, Ordering::SeqCst);
                    Ok(())
                })
            })),
        }
    }

    fn failing(id: &'static str, blocking: bool) -> Step {
        Step {
            id,
            label: id,
            blocking,
            working: None,
            defer_fix: false,
            check: Arc::new(|| Box::pin(async { Ok(CheckResult::fail("cannot be fixed here")) })),
            fix: None,
        }
    }

    fn flags() -> (Arc<AtomicBool>, Arc<AtomicU32>) {
        (Arc::new(AtomicBool::new(false)), Arc::new(AtomicU32::new(0)))
    }

    #[tokio::test]
    async fn a_failing_step_is_repaired_and_checked_again() {
        let (fixed, fixes) = flags();
        let runner = SetupRunner::new(vec![fixable("sdk", true, false, fixed, fixes.clone())]);
        let emitted = Mutex::new(Vec::new());
        let results = runner.run_auto(|status| emitted.lock().unwrap().push(status.detail.clone()), no_log()).await;
        assert_eq!(results[0].status, StepState::Pass);
        assert_eq!(fixes.load(Ordering::SeqCst), 1);
        assert_eq!(*emitted.lock().unwrap(), ["Checking…", "working on it", "fine"]);
    }

    #[tokio::test]
    async fn a_failing_blocking_step_stops_the_run() {
        let (fixed, fixes) = flags();
        let runner = SetupRunner::new(vec![failing("a", true), fixable("b", true, false, fixed, fixes.clone())]);
        let results = runner.run_auto(|_| {}, no_log()).await;
        assert_eq!(results.len(), 1, "nothing after a blocking failure runs");
        assert_eq!(fixes.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_failing_step_that_does_not_block_lets_the_rest_run() {
        let (fixed, fixes) = flags();
        let runner = SetupRunner::new(vec![failing("a", false), fixable("b", true, false, fixed, fixes)]);
        let results = runner.run_auto(|_| {}, no_log()).await;
        assert_eq!(results.iter().map(|s| s.status).collect::<Vec<_>>(), [StepState::Fail, StepState::Pass]);
    }

    #[tokio::test]
    async fn a_deferred_fix_is_only_checked_by_the_auto_run_but_runs_on_demand() {
        let (fixed, fixes) = flags();
        let runner = SetupRunner::new(vec![fixable("provisioned", false, true, fixed, fixes.clone())]);
        assert_eq!(runner.run_auto(|_| {}, no_log()).await[0].status, StepState::Fail);
        assert_eq!(fixes.load(Ordering::SeqCst), 0);
        assert_eq!(runner.run_fix("provisioned", no_log(), |_| {}).await.unwrap().status, StepState::Pass);
        assert_eq!(fixes.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_check_that_errors_reads_as_a_failure_with_the_reason() {
        let step = Step {
            id: "x",
            label: "x",
            blocking: false,
            working: None,
            defer_fix: false,
            check: Arc::new(|| Box::pin(async { Err(err!("the probe crashed")) })),
            fix: None,
        };
        let results = SetupRunner::new(vec![step]).run_all(|_| {}).await;
        assert_eq!((results[0].status, results[0].detail.as_str()), (StepState::Fail, "the probe crashed"));
    }

    #[tokio::test]
    async fn fixing_an_unknown_step_or_one_without_a_fix_is_refused() {
        let runner = SetupRunner::new(vec![failing("a", true)]);
        assert!(runner.run_fix("nope", no_log(), |_| {}).await.unwrap_err().0.contains("unknown setup step"));
        assert!(runner.run_fix("a", no_log(), |_| {}).await.unwrap_err().0.contains("no automated fix"));
    }
}
