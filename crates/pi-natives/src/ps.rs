//! N-API bindings for cross-platform process tree management.
//!
//! The platform-specific implementation lives in [`pi_shell::process`]; this
//! module is a thin shim that exposes that crate's `Process` surface to
//! JavaScript and re-exports the termination primitives used by other native
//! modules (e.g. [`crate::pty`]).

use std::time::Duration;

use napi::{
	Env, JsNumber, Result, ValueType,
	bindgen_prelude::{PromiseRaw, Unknown},
};
use napi_derive::napi;
use pi_shell::process::{self as core_process, ProcessStatus as CoreProcessStatus};
pub use pi_shell::process::{KILL_SIGNAL, TERM_SIGNAL, TerminationTargets, kill_process_group};

use crate::task;

#[derive(Default)]
#[napi(object)]
pub struct ProcessTerminateOptions<'env> {
	/// Also signal the process group when supported by the platform.
	pub group:       Option<bool>,
	/// Milliseconds to wait after polite termination before hard-killing.
	/// Omit to use the default grace period. Pass a negative value to skip the
	/// graceful phase and hard-kill immediately.
	pub graceful_ms: Option<i32>,
	/// Milliseconds to wait after hard-kill for the process tree to exit.
	pub timeout_ms:  Option<u32>,
	/// Abort signal for cancelling termination while waiting.
	pub signal:      Option<Unknown<'env>>,
}

/// Options for waiting on a process exit.
#[derive(Default)]
#[napi(object)]
pub struct ProcessWaitOptions<'env> {
	/// Milliseconds to wait before returning false. Omit to wait indefinitely.
	pub timeout_ms: Option<u32>,
	/// Abort signal for cancelling the wait.
	pub signal:     Option<Unknown<'env>>,
}

#[derive(Clone)]
#[napi(object)]
pub struct ProcessIdentityDiagnostic {
	pub code: String,
	pub errno: Option<i32>,
}

#[derive(Clone)]
#[napi(object)]
pub struct ProcessIdentityCapture {
	pub state: String,
	pub identity: Option<String>,
	pub diagnostic: Option<ProcessIdentityDiagnostic>,
}

#[derive(Clone)]
#[napi(object)]
pub struct ProcessIdentityComparison {
	pub state: String,
	pub diagnostic: Option<ProcessIdentityDiagnostic>,
}
fn validate_i32(number: f64, allow_zero: bool) -> Option<i32> {
	if !number.is_finite()
		|| number.fract() != 0.0
		|| number < 0.0
		|| (!allow_zero && number == 0.0)
		|| number > f64::from(i32::MAX)
	{
		return None;
	}
	Some(number as i32)
}

fn parse_i32<'env>(value: Unknown<'env>, name: &str, allow_zero: bool) -> Result<Option<i32>> {
	if value.get_type()? != ValueType::Number {
		return Err(napi::Error::from_reason(format!("invalid_{name}: expected a number")));
	}
	let number = unsafe { value.cast::<JsNumber>()? }.get_double()?;
	Ok(validate_i32(number, allow_zero))
}
fn unavailable_capture(code: &str, errno: Option<i32>) -> ProcessIdentityCapture {
	ProcessIdentityCapture {
		state: "unavailable".to_string(),
		identity: None,
		diagnostic: Some(ProcessIdentityDiagnostic { code: code.to_string(), errno }),
	}
}

fn unavailable_comparison(code: &str, errno: Option<i32>) -> ProcessIdentityComparison {
	ProcessIdentityComparison {
		state: "unavailable".to_string(),
		diagnostic: Some(ProcessIdentityDiagnostic { code: code.to_string(), errno }),
	}
}

#[napi]
pub fn capture_process_identity<'env>(pid: Unknown<'env>) -> Result<ProcessIdentityCapture> {
	let Some(pid) = parse_i32(pid, "pid", false)? else {
		return Ok(unavailable_capture("invalid_pid", None));
	};
	Ok(match core_process::capture_process_identity(pid) {
		core_process::ProcessIdentityCapture::Captured { identity } => ProcessIdentityCapture {
			state: "captured".to_string(), identity: Some(identity), diagnostic: None,
		},
		core_process::ProcessIdentityCapture::Unavailable { diagnostic } => ProcessIdentityCapture {
			state: "unavailable".to_string(),
			identity: None,
			diagnostic: Some(ProcessIdentityDiagnostic { code: diagnostic.code, errno: diagnostic.errno }),
		},
	})
}

#[napi]
pub fn compare_process_identity<'env>(pid: Unknown<'env>, identity: String) -> Result<ProcessIdentityComparison> {
	let Some(pid) = parse_i32(pid, "pid", false)? else {
		return Ok(unavailable_comparison("invalid_pid", None));
	};
	let (state, diagnostic) = match core_process::compare_process_identity(pid, &identity) {
		core_process::ProcessIdentityComparison::Same => ("same", None),
		core_process::ProcessIdentityComparison::Different { diagnostic } => ("different", Some(diagnostic)),
		core_process::ProcessIdentityComparison::Absent { diagnostic } => ("absent", Some(diagnostic)),
		core_process::ProcessIdentityComparison::Unavailable { diagnostic } => ("unavailable", Some(diagnostic)),
	};
	Ok(ProcessIdentityComparison {
		state: state.to_string(),
		diagnostic: diagnostic.map(|value| ProcessIdentityDiagnostic { code: value.code, errno: value.errno }),
	})
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum ProcessStatus {
	/// The referenced process is still running.
	#[napi(value = "running")]
	Running,
	/// The referenced process has exited or is no longer observable.
	#[napi(value = "exited")]
	Exited,
}

impl From<CoreProcessStatus> for ProcessStatus {
	fn from(value: CoreProcessStatus) -> Self {
		match value {
			CoreProcessStatus::Running => Self::Running,
			CoreProcessStatus::Exited => Self::Exited,
		}
	}
}

/// Stable process reference.
#[napi]
#[derive(Clone)]
pub struct Process {
	inner: core_process::Process,
}

#[napi]
#[allow(clippy::use_self, reason = "napi return types must name the exported class")]
impl Process {
	/// Open a stable process reference from a PID.
	#[napi]
	pub fn from_pid<'env>(pid: Unknown<'env>) -> Result<Option<Process>> {
		let Some(pid) = parse_i32(pid, "pid", false)? else {
			return Err(napi::Error::from_reason("invalid_pid"));
		};
		Ok(core_process::Process::from_pid(pid).map(Self::from_inner))
	}

	/// Open stable process references whose executable path matches exactly.
	#[napi]
	pub fn from_path(path: String) -> Vec<Process> {
		core_process::Process::from_path(path)
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	/// Operating-system process identifier for this process reference.
	#[napi(getter)]
	pub const fn pid(&self) -> i32 {
		self.inner.pid()
	}

	/// Parent process id for this process, when available.
	#[napi(getter)]
	pub fn ppid(&self) -> Option<i32> {
		self.inner.ppid()
	}

	/// Launch arguments for this process.
	#[napi]
	pub fn args(&self) -> Vec<String> {
		self.inner.args()
	}

	/// Send `signal` to this process and its descendants, children first.
	///
	/// On Linux and macOS the signal is forwarded as-is. On Windows there is no
	/// signal abstraction, so the `signal` argument is ignored and the entire
	/// tree is hard-killed via `TerminateProcess`. Defaults to the POSIX
	/// hard-kill signal.
	#[napi]
	pub fn kill_tree(&self, signal: Option<i32>) -> u32 {
		self.inner.kill_tree(signal)
	}

	/// Gracefully terminate this process and its descendants.
	///
	/// By default this waits 1000ms after polite termination before
	/// hard-killing. Pass `graceful_ms < 0` to skip the graceful phase.
	#[napi]
	pub fn terminate<'env>(
		&self,
		env: &'env Env,
		options: Option<ProcessTerminateOptions<'env>>,
	) -> Result<PromiseRaw<'env, bool>> {
		let options = options.unwrap_or_default();
		let group = options.group.unwrap_or(false);
		let graceful_ms = options.graceful_ms.unwrap_or(1000);
		let timeout_ms = options.timeout_ms.unwrap_or(5000);
		let ct = task::CancelToken::new(None, options.signal);
		let process = self.inner.clone();
		task::future(env, "process.terminate", async move {
			process
				.terminate_tree(group, graceful_ms, timeout_ms, ct.into_core())
				.await
				.map_err(|err| napi::Error::from_reason(err.to_string()))
		})
	}

	/// Wait until this process exits.
	///
	/// When `options.timeout_ms` is omitted, waits until the process exits.
	#[napi]
	pub fn wait_for_exit<'env>(
		&self,
		env: &'env Env,
		options: Option<ProcessWaitOptions<'env>>,
	) -> Result<PromiseRaw<'env, bool>> {
		let options = options.unwrap_or_default();
		let ct = task::CancelToken::new(None, options.signal);
		let timeout = options
			.timeout_ms
			.map(|ms| Duration::from_millis(u64::from(ms)));
		let process = self.inner.clone();
		task::future(env, "process.wait_for_exit", async move {
			process
				.wait_for_exit(timeout, ct.into_core())
				.await
				.map_err(|err| napi::Error::from_reason(err.to_string()))
		})
	}

	/// Process group id for this process, when supported by the platform.
	#[napi]
	pub fn group_id(&self) -> Option<i32> {
		self.inner.group_id()
	}

	/// Direct children of this process as stable process references.
	#[napi]
	pub fn children(&self) -> Vec<Process> {
		self
			.inner
			.children()
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	/// Current status of this process reference.
	#[napi]
	pub fn status(&self) -> ProcessStatus {
		self.inner.status().into()
	}
}

impl Process {
	const fn from_inner(inner: core_process::Process) -> Self {
		Self { inner }
	}
}
