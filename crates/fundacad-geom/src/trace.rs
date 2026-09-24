//! The OpenCASCADE calls the feature being built has made, so a failure can
//! name the kernel operation that refused and what it was handed.
//!
//! Thread-local and per feature: the build loop clears it before each feature
//! and takes it when one fails. Calls made on a `par` worker thread are not
//! seen, the trail is a best effort report and never changes a result.
//! Arguments are formatted only for a call that failed, so a passing build pays
//! for a name and a timestamp per call.

use std::cell::RefCell;
use std::time::Instant;

use serde_json::{json, Value};

/// Enough to show the failing call and what led up to it.
const KEEP: usize = 24;

#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    /// The OpenCASCADE class or algorithm, `BRepAlgoAPI_Cut`.
    pub op: &'static str,
    pub args: Option<String>,
    pub error: Option<String>,
    /// `None` when the caller could not time it.
    pub ms: Option<f64>,
}

impl Call {
    pub fn wire(&self) -> Value {
        let mut v = json!({ "op": self.op });
        if let Some(ms) = self.ms {
            v["ms"] = json!((ms * 100.0).round() / 100.0);
        }
        if let Some(a) = &self.args {
            v["args"] = Value::String(a.clone());
        }
        if let Some(e) = &self.error {
            v["error"] = Value::String(e.clone());
        }
        v
    }
}

/// Arguments worded only when the trail is read.
type Later = Box<dyn FnOnce() -> String>;

thread_local! {
    static CALLS: RefCell<Vec<(Call, Option<Later>)>> = const { RefCell::new(Vec::new()) };
}

pub fn begin() {
    CALLS.with(|c| c.borrow_mut().clear());
}

pub fn take() -> Vec<Call> {
    let calls = CALLS.with(|c| std::mem::take(&mut *c.borrow_mut()));
    calls
        .into_iter()
        .map(|(mut call, later)| {
            if let Some(later) = later {
                call.args = Some(later());
            }
            call
        })
        .collect()
}

fn push(call: Call) {
    push_with(call, None);
}

fn push_with(call: Call, later: Option<Later>) {
    CALLS.with(|c| {
        let mut v = c.borrow_mut();
        if v.len() >= KEEP {
            // A failure is the one entry the report exists for, so passing calls
            // make room first.
            let at = v.iter().position(|x| x.0.error.is_none()).unwrap_or(0);
            v.remove(at);
        }
        v.push((call, later));
    });
}

/// `failed`, with arguments worded only if the feature fails in the end: a
/// blend that recovers from a refused kernel call never reads them, and
/// describing a B-spline body costs a fifth of a second.
pub fn failed_later(op: &'static str, args: impl FnOnce() -> String + 'static, error: impl Into<String>, ms: Option<f64>) {
    push_with(
        Call {
            op,
            args: None,
            error: Some(error.into()),
            ms,
        },
        Some(Box::new(args)),
    );
}

/// Record a failure that did not come through `call`, such as an error value
/// the high level bindings return with the exception text already inside it.
pub fn failed(op: &'static str, args: Option<String>, error: impl Into<String>, ms: Option<f64>) {
    push(Call {
        op,
        args,
        error: Some(error.into()),
        ms,
    });
}

pub fn call<T, E: std::fmt::Display>(
    op: &'static str,
    args: impl FnOnce() -> String,
    f: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    let began = Instant::now();
    let r = f();
    let ms = began.elapsed().as_secs_f64() * 1000.0;
    let (args, error) = match &r {
        Ok(_) => (None, None),
        Err(e) => (Some(args()), Some(e.to_string())),
    };
    push(Call {
        op,
        args,
        error,
        ms: Some(ms),
    });
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_failures_when_full() {
        begin();
        let _ = call::<(), String>("Bad", || "x=1".into(), || Err("StdFail_NotDone".into()));
        for _ in 0..KEEP * 2 {
            let _ = call::<(), String>("Ok", String::new, || Ok(()));
        }
        let calls = take();
        assert_eq!(calls.len(), KEEP);
        assert_eq!(calls[0].op, "Bad");
        assert_eq!(calls[0].args.as_deref(), Some("x=1"));
        assert!(calls[1..]
            .iter()
            .all(|c| c.error.is_none() && c.args.is_none()));
        assert!(take().is_empty());
    }

    #[test]
    fn words_later_arguments_only_when_read() {
        use std::cell::Cell;
        use std::rc::Rc;
        let worded = Rc::new(Cell::new(0));
        let w = worded.clone();
        begin();
        failed_later("Dropped", move || { w.set(w.get() + 1); "a".into() }, "NotDone", None);
        begin();
        assert_eq!(worded.get(), 0);
        let w = worded.clone();
        failed_later("Read", move || { w.set(w.get() + 1); "b".into() }, "NotDone", None);
        let calls = take();
        assert_eq!(worded.get(), 1);
        assert_eq!(calls[0].args.as_deref(), Some("b"));
    }
}
