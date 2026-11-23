//! v0.5 `localis-media` URI scheme: streams the stored original of an audio/video version
//! to the webview's `<audio>`/`<video>` with HTTP Range support. The URL path is only a
//! version id (`api.mediaUrl(versionId)`); nothing else on disk is reachable.
//!
//! - Only existing audio/video versions are served; existence and size of the stored file
//!   are checked on every request (the full SHA-256 was verified at import).
//! - Each response carries at most [`RANGE_MAX`] bytes read from the file at the requested
//!   offset, so a 4 GB video is never read whole. A request without `Range` gets the whole
//!   file (200) only when it is at most `RANGE_MAX`; for larger files it is answered like
//!   `Range: bytes=0-` (206 with the first block), which media elements handle.
//! - `bytes=a-b`, `bytes=a-` and `bytes=-n` are supported; for a multi-range request the
//!   first range is served. A range that starts past the end gets 416 with
//!   `Content-Range: bytes */<size>`; a malformed `Range` header is ignored (as RFC 9110
//!   allows).

use std::io::{Read, Seek, SeekFrom};

use tauri::http::{header, Request, Response, StatusCode};

use crate::commands::AppState;

/// Max bytes in one response.
pub const RANGE_MAX: u64 = 4 * 1024 * 1024;

/// A parsed `Range` header against a file of known size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeSpec {
    /// No (usable) Range header.
    Full,
    /// Inclusive byte range within the file.
    Bytes {
        start: u64,
        end: u64,
    },
    Unsatisfiable,
}

/// Parses a `Range` header for a file of `size` bytes.
pub fn parse_range(value: Option<&str>, size: u64) -> RangeSpec {
    let Some(value) = value else {
        return RangeSpec::Full;
    };
    let Some(spec) = value.trim().strip_prefix("bytes=") else {
        return RangeSpec::Full;
    };
    let first = spec.split(',').next().unwrap_or("").trim();
    let Some((a, b)) = first.split_once('-') else {
        return RangeSpec::Full;
    };
    let (a, b) = (a.trim(), b.trim());
    let num = |s: &str| -> Option<u64> {
        (!s.is_empty() && s.len() <= 20 && s.bytes().all(|c| c.is_ascii_digit()))
            .then(|| s.parse().ok())
            .flatten()
    };
    match (a.is_empty(), b.is_empty()) {
        // bytes=-n: the last n bytes.
        (true, false) => match num(b) {
            Some(0) => RangeSpec::Unsatisfiable,
            Some(n) if size > 0 => RangeSpec::Bytes {
                start: size.saturating_sub(n),
                end: size - 1,
            },
            Some(_) => RangeSpec::Unsatisfiable,
            None => RangeSpec::Full,
        },
        (false, _) => {
            let Some(start) = num(a) else {
                return RangeSpec::Full;
            };
            let end = if b.is_empty() {
                None
            } else {
                match num(b) {
                    Some(e) if e >= start => Some(e),
                    _ => return RangeSpec::Full,
                }
            };
            if start >= size {
                return RangeSpec::Unsatisfiable;
            }
            RangeSpec::Bytes {
                start,
                end: end.unwrap_or(size - 1).min(size - 1),
            }
        }
        (true, true) => RangeSpec::Full,
    }
}

/// A response ready to be converted to `http::Response`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaResponse {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

fn simple(status: u16) -> MediaResponse {
    MediaResponse {
        status,
        headers: vec![
            ("content-length", "0".into()),
            ("cache-control", "no-store".into()),
        ],
        body: Vec::new(),
    }
}

/// Builds the response for `method` and `range` from `reader` (a file of `size` bytes).
pub fn respond(
    method: &str,
    range: Option<&str>,
    size: u64,
    content_type: &str,
    reader: &mut (impl Read + Seek),
) -> std::io::Result<MediaResponse> {
    let head = match method {
        "GET" => false,
        "HEAD" => true,
        _ => {
            let mut r = simple(405);
            r.headers.push(("allow", "GET, HEAD".into()));
            return Ok(r);
        }
    };
    let mut headers: Vec<(&'static str, String)> = vec![
        ("content-type", content_type.to_owned()),
        ("accept-ranges", "bytes".into()),
        ("cache-control", "no-store".into()),
        ("x-content-type-options", "nosniff".into()),
    ];
    let spec = match parse_range(range, size) {
        RangeSpec::Full if size <= RANGE_MAX => None,
        RangeSpec::Full if size > 0 => Some((0, RANGE_MAX - 1)),
        RangeSpec::Full => None,
        RangeSpec::Bytes { start, end } => Some((start, end.min(start + RANGE_MAX - 1))),
        RangeSpec::Unsatisfiable => {
            headers.push(("content-range", format!("bytes */{size}")));
            headers.push(("content-length", "0".into()));
            return Ok(MediaResponse {
                status: 416,
                headers,
                body: Vec::new(),
            });
        }
    };
    let (status, start, len) = match spec {
        None => (200, 0, size),
        Some((start, end)) => {
            headers.push(("content-range", format!("bytes {start}-{end}/{size}")));
            (206, start, end - start + 1)
        }
    };
    headers.push(("content-length", len.to_string()));
    let mut body = Vec::new();
    if !head && len > 0 {
        reader.seek(SeekFrom::Start(start))?;
        body = vec![0u8; len as usize];
        reader.read_exact(&mut body)?;
    }
    Ok(MediaResponse {
        status,
        headers,
        body,
    })
}

/// Version id from the URL path (`/<id>`): ASCII letters, digits and `-` only.
pub fn version_id_from_path(path: &str) -> Option<&str> {
    let id = path.strip_prefix('/').unwrap_or(path);
    let valid = !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    valid.then_some(id)
}

/// Serves one request of the `localis-media` scheme (runs off the main thread).
pub fn handle(state: &AppState, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let response = serve(state, request);
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(response.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR));
    for (name, value) in &response.headers {
        builder = builder.header(*name, value);
    }
    builder
        .body(response.body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn serve(state: &AppState, request: &Request<Vec<u8>>) -> MediaResponse {
    let Some(id) = version_id_from_path(request.uri().path()) else {
        return simple(404);
    };
    let blob = state.with_store(|store| Ok(store.media_blob(id)?));
    let (path, size, media_type) = match blob {
        Ok(found) => found,
        Err(err) if err.code == crate::error::ErrorCode::NotFound => return simple(404),
        Err(_) => return simple(500),
    };
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok());
    let result = std::fs::File::open(&path).and_then(|mut file| {
        // The file must still have the recorded size (checked again per request).
        if file.metadata()?.len() != size {
            return Err(std::io::Error::other("stored file changed size"));
        }
        respond(
            request.method().as_str(),
            range,
            size,
            &media_type,
            &mut file,
        )
    });
    match result {
        Ok(response) => response,
        Err(err) => {
            eprintln!("localis: media protocol: {}: {err}", path.display());
            simple(500)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn range_parsing() {
        let p = |v: &str| parse_range(Some(v), 1000);
        assert_eq!(parse_range(None, 1000), RangeSpec::Full);
        assert_eq!(p("bytes=0-"), RangeSpec::Bytes { start: 0, end: 999 });
        assert_eq!(p("bytes=10-19"), RangeSpec::Bytes { start: 10, end: 19 });
        assert_eq!(
            p("bytes=990-5000"),
            RangeSpec::Bytes {
                start: 990,
                end: 999
            }
        );
        assert_eq!(
            p("bytes=-100"),
            RangeSpec::Bytes {
                start: 900,
                end: 999
            }
        );
        assert_eq!(p("bytes=-5000"), RangeSpec::Bytes { start: 0, end: 999 });
        assert_eq!(p("bytes=5-9, 20-30"), RangeSpec::Bytes { start: 5, end: 9 });
        assert_eq!(p("bytes=1000-"), RangeSpec::Unsatisfiable);
        assert_eq!(p("bytes=2000-3000"), RangeSpec::Unsatisfiable);
        assert_eq!(p("bytes=-0"), RangeSpec::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-"), 0), RangeSpec::Unsatisfiable);
        // Malformed headers are ignored.
        for bad in [
            "items=0-1",
            "bytes=a-b",
            "bytes=5-1",
            "bytes=-",
            "bytes=1",
            "bytes=+1-2",
        ] {
            assert_eq!(p(bad), RangeSpec::Full, "{bad}");
        }
    }

    fn header<'a>(r: &'a MediaResponse, name: &str) -> Option<&'a str> {
        r.headers
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn responses_200_206_416() {
        let data: Vec<u8> = (0..=255u8).cycle().take(5000).collect();
        let mut file = Cursor::new(data.clone());
        let r = respond("GET", None, 5000, "audio/mpeg", &mut file).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, data);
        assert_eq!(header(&r, "content-type"), Some("audio/mpeg"));
        assert_eq!(header(&r, "accept-ranges"), Some("bytes"));
        assert_eq!(header(&r, "content-length"), Some("5000"));
        assert_eq!(header(&r, "content-range"), None);

        let r = respond("GET", Some("bytes=100-199"), 5000, "video/mp4", &mut file).unwrap();
        assert_eq!(r.status, 206);
        assert_eq!(r.body, &data[100..200]);
        assert_eq!(header(&r, "content-range"), Some("bytes 100-199/5000"));
        assert_eq!(header(&r, "content-length"), Some("100"));

        let r = respond("GET", Some("bytes=-10"), 5000, "video/mp4", &mut file).unwrap();
        assert_eq!(r.body, &data[4990..]);
        assert_eq!(header(&r, "content-range"), Some("bytes 4990-4999/5000"));

        let r = respond("GET", Some("bytes=5000-"), 5000, "video/mp4", &mut file).unwrap();
        assert_eq!(r.status, 416);
        assert!(r.body.is_empty());
        assert_eq!(header(&r, "content-range"), Some("bytes */5000"));

        let r = respond("HEAD", Some("bytes=0-9"), 5000, "audio/wav", &mut file).unwrap();
        assert_eq!((r.status, r.body.len()), (206, 0));
        assert_eq!(header(&r, "content-length"), Some("10"));

        let r = respond("POST", None, 5000, "audio/wav", &mut file).unwrap();
        assert_eq!(r.status, 405);
        assert_eq!(header(&r, "allow"), Some("GET, HEAD"));
    }

    #[test]
    fn large_files_are_served_in_blocks() {
        /// A "file" of `size` bytes whose content is its offset modulo 251, never allocated.
        struct Virtual {
            size: u64,
            pos: u64,
        }
        impl Read for Virtual {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let n = buf.len().min((self.size - self.pos) as usize);
                for (i, b) in buf[..n].iter_mut().enumerate() {
                    *b = ((self.pos + i as u64) % 251) as u8;
                }
                self.pos += n as u64;
                Ok(n)
            }
        }
        impl Seek for Virtual {
            fn seek(&mut self, to: SeekFrom) -> std::io::Result<u64> {
                if let SeekFrom::Start(p) = to {
                    self.pos = p;
                }
                Ok(self.pos)
            }
        }
        let size = 4 * 1024 * 1024 * 1024u64;
        let mut f = Virtual { size, pos: 0 };
        // No Range on a big file: first block as 206.
        let r = respond("GET", None, size, "video/mp4", &mut f).unwrap();
        assert_eq!(r.status, 206);
        assert_eq!(r.body.len() as u64, RANGE_MAX);
        assert_eq!(
            header(&r, "content-range"),
            Some(format!("bytes 0-{}/{size}", RANGE_MAX - 1).as_str())
        );
        // An open-ended range far in the file: capped block at the right offset.
        let start = size - 10 * 1024 * 1024;
        let r = respond(
            "GET",
            Some(&format!("bytes={start}-")),
            size,
            "video/mp4",
            &mut f,
        )
        .unwrap();
        assert_eq!(r.body.len() as u64, RANGE_MAX);
        assert_eq!(r.body[0], (start % 251) as u8);
        assert_eq!(
            header(&r, "content-range"),
            Some(format!("bytes {start}-{}/{size}", start + RANGE_MAX - 1).as_str())
        );
    }

    #[test]
    fn only_plain_ids_are_accepted() {
        assert_eq!(
            version_id_from_path("/0b8f5c3e-1d2a-4c4b-9a77-3f1e2d4c5b6a"),
            Some("0b8f5c3e-1d2a-4c4b-9a77-3f1e2d4c5b6a")
        );
        for bad in ["/", "/../localis.db", "/a/b", "/a%2Fb", "/a.mp3", "/a?b"] {
            assert_eq!(version_id_from_path(bad), None, "{bad}");
        }
    }
}
