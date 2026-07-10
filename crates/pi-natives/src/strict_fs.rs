//! Darwin-only filesystem classification from a borrowed directory file descriptor.
//!
//! This module deliberately reports classification evidence only. It never opens or
//! closes the descriptor and has no pathname or numeric filesystem-type fallback.

use napi::{bindgen_prelude::Unknown, JsNumber, ValueType};
use napi_derive::napi;

#[derive(Clone)]
#[napi(object)]
pub struct StrictFsDiagnostic {
	pub code: String,
	pub errno: Option<i32>,
}

#[derive(Clone)]
#[napi(object)]
pub struct StrictFsResult {
	pub state: String,
	pub platform: Option<String>,
	#[napi(js_name = "f_fstypename")]
	pub f_fstypename: Option<String>,
	pub fsid: Option<String>,
	pub diagnostic: Option<StrictFsDiagnostic>,
}

impl StrictFsResult {
	fn unavailable(code: &str, errno: Option<i32>) -> Self {
		Self {
			state: "unavailable".to_string(),
			platform: None,
			f_fstypename: None,
			fsid: None,
			diagnostic: Some(StrictFsDiagnostic { code: code.to_string(), errno }),
		}
	}
}
fn validate_fd(number: f64) -> Option<i32> {
	if !number.is_finite() || number.fract() != 0.0 || number < 0.0 || number > f64::from(i32::MAX) {
		return None;
	}
	Some(number as i32)
}

fn parse_fd<'env>(value: Unknown<'env>) -> napi::Result<Option<i32>> {
	if value.get_type()? != ValueType::Number {
		return Err(napi::Error::from_reason("invalid_fd: expected a number"));
	}
	let number = unsafe { value.cast::<JsNumber>()? }.get_double()?;
	Ok(validate_fd(number))
}

/// Classify the filesystem containing a borrowed directory descriptor.
///
/// The descriptor remains owned by the caller. On non-Darwin platforms this
/// always returns unavailable without inspecting the descriptor.
#[napi]
pub fn classify_strict_fs<'env>(fd: Unknown<'env>) -> napi::Result<StrictFsResult> {
	let Some(fd) = parse_fd(fd)? else {
		return Ok(StrictFsResult::unavailable("invalid_fd", None));
	};
	return Ok(classify_fd(fd));
}

fn classify_fd(fd: i32) -> StrictFsResult {
	#[cfg(target_os = "macos")]
	{
		return classify_darwin(fd);
	}

	#[cfg(not(target_os = "macos"))]
	{
		let _ = fd;
		StrictFsResult::unavailable("unsupported_platform", None)
	}
}

/// Validate the native `f_fstypename` field without accepting truncation or
/// non-canonical bytes after its first NUL terminator.
#[cfg(any(target_os = "macos", test))]
fn parse_fstypename(field: &[u8]) -> Option<&[u8]> {
	let nul = field.iter().position(|&byte| byte == 0)?;
	if !(1..=15).contains(&nul) || field[nul + 1..].iter().any(|&byte| byte != 0) {
		return None;
	}
	if field[..nul].iter().all(|&byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-')) {
		Some(&field[..nul])
	} else {
		None
	}
}

#[cfg(any(target_os = "macos", test))]
fn format_fsid(parts: [i32; 2]) -> String {
	format!("{:08x}:{:08x}", parts[0] as u32, parts[1] as u32)
}

#[cfg(target_os = "macos")]
fn classify_darwin(fd: i32) -> StrictFsResult {
	use std::mem::MaybeUninit;

	let mut stat = MaybeUninit::<libc::stat>::uninit();
	if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
		return StrictFsResult::unavailable("fstat_failed", std::io::Error::last_os_error().raw_os_error());
	}
	let stat = unsafe { stat.assume_init() };
	if (stat.st_mode & libc::S_IFMT) != libc::S_IFDIR {
		return StrictFsResult::unavailable("not_directory", None);
	}

	let mut fs = MaybeUninit::<libc::statfs>::uninit();
	if unsafe { libc::fstatfs(fd, fs.as_mut_ptr()) } != 0 {
		return StrictFsResult::unavailable("fstatfs_failed", std::io::Error::last_os_error().raw_os_error());
	}
	let fs = unsafe { fs.assume_init() };
	let name_field = fs.f_fstypename.iter().map(|&byte| byte as u8).collect::<Vec<_>>();
	let Some(name) = parse_fstypename(&name_field) else {
		return StrictFsResult::unavailable("invalid_fstypename", None);
	};
	let name = String::from_utf8(name.to_vec()).expect("validated ASCII filesystem name");
	StrictFsResult {
		state: "classified".to_string(),
		platform: Some("darwin".to_string()),
		f_fstypename: Some(name),
		fsid: Some(format_fsid(fs.f_fsid.val)),
		diagnostic: None,
	}
}

#[cfg(test)]
mod tests {
	use super::{format_fsid, parse_fstypename};

	#[test]
	fn accepts_canonical_names_and_zero_suffix() {
		assert_eq!(parse_fstypename(b"apfs\0\0\0\0"), Some(&b"apfs"[..]));
		assert_eq!(parse_fstypename(b"a0_-\0\0\0\0"), Some(&b"a0_-"[..]));
	}

	#[test]
	fn rejects_invalid_name_boundaries_and_bytes() {
		assert_eq!(parse_fstypename(b"\0\0\0\0"), None);
		assert_eq!(parse_fstypename(b"abcdefghijklmnop"), None);
		assert_eq!(parse_fstypename(b"APFS\0\0\0\0"), None);
		assert_eq!(parse_fstypename(b"apfs\0x\0\0"), None);
		assert_eq!(parse_fstypename(b"apfs\0\0\0\0"), Some(&b"apfs"[..]));
	}

	#[test]
	fn formats_signed_fsid_bit_patterns() {
		assert_eq!(format_fsid([0, -1]), "00000000:ffffffff");
		assert_eq!(format_fsid([i32::MIN, i32::MAX]), "80000000:7fffffff");
	}

	#[cfg(not(target_os = "macos"))]
	#[test]
	fn unsupported_platform_does_not_inspect_fd() {
		let result = super::super::strict_fs::classify_fd(0);
		assert_eq!(result.state, "unavailable");
		assert_eq!(result.diagnostic.as_ref().unwrap().code, "unsupported_platform");
	}

	#[cfg(target_os = "macos")]
	#[test]
	fn classifies_borrowed_directory_fd_without_taking_ownership() {
		use std::os::fd::AsRawFd;

		let directory = std::fs::File::open(".").expect("open current directory");
		let result = super::super::strict_fs::classify_fd(directory.as_raw_fd());
		assert_eq!(result.state, "classified");
		assert_eq!(result.platform.as_deref(), Some("darwin"));
		assert!(result.f_fstypename.as_deref().is_some_and(|name| name == "apfs"));
		assert!(result.fsid.as_deref().is_some_and(|value| {
			let mut parts = value.split(':');
			let valid = parts.next().is_some_and(|part| part.len() == 8 && part.bytes().all(|byte| byte.is_ascii_hexdigit()))
				&& parts.next().is_some_and(|part| part.len() == 8 && part.bytes().all(|byte| byte.is_ascii_hexdigit()));
			valid && parts.next().is_none()
		}));
		assert!(directory.metadata().is_ok());
	}
}
