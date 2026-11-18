//! Metadata of raw-body import requests, sent by `src/api/client.ts` as headers.
//! Every header is validated; problems are reported as `validation` errors with a
//! generic message and the specifics in `detail`.

use tauri::http::HeaderMap;
use tauri::ipc::InvokeBody;

use crate::error::AppError;

/// Headers of `import_document`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportHeaders {
    pub project_id: String,
    /// `None` = project root (empty or missing header).
    pub folder_id: Option<String>,
    pub file_name: String,
    /// ms since the Unix epoch (`File.lastModified`).
    pub last_modified: Option<i64>,
}

/// Headers of `import_version`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionHeaders {
    pub document_id: String,
    pub file_name: String,
    pub last_modified: Option<i64>,
}

impl ImportHeaders {
    pub fn parse(headers: &HeaderMap) -> Result<Self, AppError> {
        Ok(ImportHeaders {
            project_id: required_id(headers, "x-project-id")?,
            folder_id: optional_id(headers, "x-folder-id")?,
            file_name: file_name(headers)?,
            last_modified: last_modified(headers)?,
        })
    }
}

impl VersionHeaders {
    pub fn parse(headers: &HeaderMap) -> Result<Self, AppError> {
        Ok(VersionHeaders {
            document_id: required_id(headers, "x-document-id")?,
            file_name: file_name(headers)?,
            last_modified: last_modified(headers)?,
        })
    }
}

/// The raw bytes of the request; a JSON body is refused.
pub fn raw_body(body: &InvokeBody) -> Result<&[u8], AppError> {
    match body {
        InvokeBody::Raw(bytes) => Ok(bytes),
        InvokeBody::Json(_) => Err(AppError::bad_request(
            "expected a raw binary body, got JSON",
        )),
    }
}

/// Single header value as visible ASCII; `None` when absent.
fn header<'a>(headers: &'a HeaderMap, name: &str) -> Result<Option<&'a str>, AppError> {
    let mut values = headers.get_all(name).iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(AppError::bad_request(format!("header {name} repeated")));
    }
    value
        .to_str()
        .map(Some)
        .map_err(|_| AppError::bad_request(format!("header {name} is not visible ASCII")))
}

const ID_MAX: usize = 64;

fn check_id(name: &str, value: &str) -> Result<(), AppError> {
    if value.len() > ID_MAX
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(AppError::bad_request(format!(
            "header {name} is not a valid id"
        )));
    }
    Ok(())
}

fn required_id(headers: &HeaderMap, name: &str) -> Result<String, AppError> {
    match header(headers, name)? {
        Some(value) if !value.is_empty() => {
            check_id(name, value)?;
            Ok(value.to_owned())
        }
        _ => Err(AppError::bad_request(format!("header {name} missing"))),
    }
}

fn optional_id(headers: &HeaderMap, name: &str) -> Result<Option<String>, AppError> {
    match header(headers, name)? {
        Some(value) if !value.is_empty() => {
            check_id(name, value)?;
            Ok(Some(value.to_owned()))
        }
        _ => Ok(None),
    }
}

fn file_name(headers: &HeaderMap) -> Result<String, AppError> {
    let raw = header(headers, "x-file-name")?
        .ok_or_else(|| AppError::bad_request("header x-file-name missing"))?;
    // Name checks (empty, control characters, separators) are the core's job.
    percent_decode(raw).map_err(|why| AppError::bad_request(format!("header x-file-name: {why}")))
}

fn last_modified(headers: &HeaderMap) -> Result<Option<i64>, AppError> {
    match header(headers, "x-last-modified")? {
        None | Some("") => Ok(None),
        Some(value) => {
            let valid = !value.is_empty()
                && value.len() <= 20
                && value
                    .strip_prefix('-')
                    .unwrap_or(value)
                    .bytes()
                    .all(|b| b.is_ascii_digit());
            let parsed = if valid {
                value.parse::<i64>().ok()
            } else {
                None
            };
            parsed
                .map(Some)
                .ok_or_else(|| AppError::bad_request("header x-last-modified is not an integer"))
        }
    }
}

/// Decodes `%XX` escapes (as produced by `encodeURIComponent`) and requires UTF-8.
/// Other characters are kept as they are; `+` is not a space.
pub fn percent_decode(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes
                .get(i + 1..i + 3)
                .ok_or_else(|| format!("truncated escape at byte {i}"))?;
            let value = (hex_value(hex[0]), hex_value(hex[1]));
            let (Some(hi), Some(lo)) = value else {
                return Err(format!("invalid escape at byte {i}"));
            };
            out.push(hi << 4 | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "not valid UTF-8 once decoded".to_owned())
}

fn hex_value(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}
