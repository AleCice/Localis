//! Text extraction from stored originals. Extractors are pure functions over bytes;
//! [`extract_guarded`] runs one on a separate thread so a panic or a runaway parse in a
//! malformed file can never take down the app.

mod docx;
mod pdf;
mod text;

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use crate::formats::DocumentKind;

/// Successful extraction: text units (1-based page or block numbers, non-empty text).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Extracted {
    pub units: Vec<(u32, String)>,
    /// Number of pages, PDFs only.
    pub page_count: Option<u32>,
}

/// Failed extraction: Italian message for the UI and technical detail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractError {
    pub message: String,
    pub detail: String,
}

impl ExtractError {
    pub(crate) fn new(message: &str, detail: impl ToString) -> Self {
        ExtractError {
            message: message.to_owned(),
            detail: detail.to_string(),
        }
    }
}

pub type ExtractResult = std::result::Result<Extracted, ExtractError>;

/// Runs the extractor for `kind` on the current thread (panics are not caught).
pub fn extract(kind: DocumentKind, bytes: &[u8]) -> ExtractResult {
    match kind {
        DocumentKind::Pdf => pdf::extract(bytes),
        DocumentKind::Text | DocumentKind::Markdown => text::extract(bytes),
        DocumentKind::Docx => docx::extract(bytes),
        DocumentKind::Image | DocumentKind::Audio | DocumentKind::Video => Err(ExtractError::new(
            "Questo formato non ha testo da estrarre.",
            "extract called for an image or a recording",
        )),
    }
}

/// Stack for the extraction thread: parsers recurse on nested structures.
const EXTRACT_STACK_SIZE: usize = 32 * 1024 * 1024;

/// Runs [`extract`] on a dedicated thread, catching panics and giving up after
/// `timeout`. On timeout the thread is left to finish on its own (Rust threads cannot
/// be killed) and its result is discarded.
pub fn extract_guarded(
    kind: DocumentKind,
    bytes: Arc<Vec<u8>>,
    timeout: Duration,
) -> ExtractResult {
    run_guarded(move || extract(kind, &bytes), timeout)
}

fn run_guarded(
    f: impl FnOnce() -> ExtractResult + Send + 'static,
    timeout: Duration,
) -> ExtractResult {
    let (tx, rx) = mpsc::sync_channel(1);
    let spawned = std::thread::Builder::new()
        .name("localis-extract-run".into())
        .stack_size(EXTRACT_STACK_SIZE)
        .spawn(move || {
            let result = catch_unwind(AssertUnwindSafe(f));
            let _ = tx.send(result);
        });
    if let Err(err) = spawned {
        return Err(ExtractError::new(
            "Impossibile avviare l'estrazione del testo.",
            format!("cannot spawn extraction thread: {err}"),
        ));
    }
    match rx.recv_timeout(timeout) {
        Ok(Ok(result)) => result,
        Ok(Err(panic)) => Err(ExtractError::new(
            "Il file non può essere letto: potrebbe essere danneggiato.",
            format!("extractor panicked: {}", panic_message(panic.as_ref())),
        )),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(ExtractError::new(
            "L'estrazione del testo ha richiesto troppo tempo.",
            format!("extraction did not finish within {} s", timeout.as_secs()),
        )),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(ExtractError::new(
            "Il file non può essere letto: potrebbe essere danneggiato.",
            "extraction thread ended without a result",
        )),
    }
}

fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = panic.downcast_ref::<&str>() {
        (*s).to_owned()
    } else if let Some(s) = panic.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic payload".to_owned()
    }
}

/// Normalizes a unit of text: drops NUL and other C0 controls except tab/newline,
/// trims trailing spaces on each line and surrounding blank lines.
pub(crate) fn clean_unit(raw: &str) -> String {
    let filtered: String = raw
        .chars()
        .map(|c| if c == '\r' { '\n' } else { c })
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .collect();
    let lines: Vec<&str> = filtered.lines().map(str::trim_end).collect();
    lines.join("\n").trim().to_owned()
}

/// Pushes non-empty units numbered from 1 in order.
pub(crate) fn number_units(texts: impl IntoIterator<Item = String>) -> Vec<(u32, String)> {
    texts
        .into_iter()
        .map(|t| clean_unit(&t))
        .filter(|t| !t.is_empty())
        .zip(1u32..)
        .map(|(t, n)| (n, t))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_unit_rules() {
        assert_eq!(clean_unit("  \n a \u{0}b  \r\n\n"), "a b");
        assert_eq!(clean_unit("x\ty"), "x\ty");
        assert_eq!(clean_unit("\n\n"), "");
    }

    #[test]
    fn panics_become_errors() {
        let err =
            run_guarded(|| panic!("synthetic extractor bug"), Duration::from_secs(5)).unwrap_err();
        assert_eq!(
            err.message,
            "Il file non può essere letto: potrebbe essere danneggiato."
        );
        assert!(
            err.detail.contains("synthetic extractor bug"),
            "{}",
            err.detail
        );
    }

    #[test]
    fn runaway_extraction_times_out() {
        let err = run_guarded(
            || {
                std::thread::sleep(Duration::from_secs(2));
                Ok(Extracted::default())
            },
            Duration::from_millis(50),
        )
        .unwrap_err();
        assert_eq!(
            err.message,
            "L'estrazione del testo ha richiesto troppo tempo."
        );
    }

    #[test]
    fn guarded_success_and_image_kind() {
        let ok = extract_guarded(
            DocumentKind::Text,
            Arc::new(b"uno\n\ndue".to_vec()),
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(ok.units, vec![(1, "uno".into()), (2, "due".into())]);
        assert!(extract(DocumentKind::Image, b"").is_err());
    }
}
