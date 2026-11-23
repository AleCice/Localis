//! Format recognition for imported files: magic bytes plus extension, which must agree.

use std::io::{Cursor, Read};

use crate::error::{CoreError, Result};
use crate::library::IMPORT_MAX_BYTES;
use crate::media::{probe, MediaInfo};

/// v0.5: max size of an audio/video file (`MEDIA_IMPORT_MAX_BYTES` in `src/api/types.ts`).
pub const MEDIA_IMPORT_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Kind of document, as exposed to the UI (`DocumentKind` in `src/api/types.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DocumentKind {
    Pdf,
    Text,
    Markdown,
    Docx,
    Image,
    /// v0.5: MP3, M4A, WAV.
    Audio,
    /// v0.5: MP4 (its audio track can be transcribed).
    Video,
}

impl DocumentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DocumentKind::Pdf => "pdf",
            DocumentKind::Text => "text",
            DocumentKind::Markdown => "markdown",
            DocumentKind::Docx => "docx",
            DocumentKind::Image => "image",
            DocumentKind::Audio => "audio",
            DocumentKind::Video => "video",
        }
    }

    pub(crate) fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "pdf" => DocumentKind::Pdf,
            "text" => DocumentKind::Text,
            "markdown" => DocumentKind::Markdown,
            "docx" => DocumentKind::Docx,
            "image" => DocumentKind::Image,
            "audio" => DocumentKind::Audio,
            "video" => DocumentKind::Video,
            _ => return None,
        })
    }

    /// Whether this kind gets a text-extraction job.
    pub fn has_text(self) -> bool {
        matches!(
            self,
            DocumentKind::Pdf | DocumentKind::Text | DocumentKind::Markdown | DocumentKind::Docx
        )
    }

    /// Audio or video: imported in chunks, played through the media protocol, transcribed.
    pub fn is_media(self) -> bool {
        matches!(self, DocumentKind::Audio | DocumentKind::Video)
    }

    /// Max import size for this kind.
    pub fn max_bytes(self) -> u64 {
        if self.is_media() {
            MEDIA_IMPORT_MAX_BYTES
        } else {
            IMPORT_MAX_BYTES as u64
        }
    }
}

/// Kind implied by the extension of `file_name` (content not checked yet); `unsupported`
/// for unknown extensions. Used to apply the size limit before receiving a file.
pub fn kind_for_file_name(file_name: &str) -> Result<DocumentKind> {
    let Some(ext) = extension(file_name) else {
        return Err(CoreError::unsupported(NO_EXTENSION));
    };
    Ok(match ext.as_str() {
        "pdf" => DocumentKind::Pdf,
        "docx" => DocumentKind::Docx,
        "txt" => DocumentKind::Text,
        "md" | "markdown" => DocumentKind::Markdown,
        "png" | "jpg" | "jpeg" | "gif" | "webp" => DocumentKind::Image,
        "mp3" | "m4a" | "wav" => DocumentKind::Audio,
        "mp4" => DocumentKind::Video,
        _ => return Err(unknown_extension(&ext)),
    })
}

const NO_EXTENSION: &str = "Formato non supportato: il file non ha un'estensione riconoscibile.";

fn unknown_extension(ext: &str) -> CoreError {
    CoreError::unsupported(format!(
        "Formato non supportato: .{}",
        ext.chars().take(20).collect::<String>()
    ))
}

/// Result of format recognition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedFormat {
    pub kind: DocumentKind,
    pub media_type: &'static str,
    /// Pixel dimensions, images and video (when the container states them).
    pub image_size: Option<(u32, u32)>,
    /// Audio/video duration in milliseconds, when the container states it.
    pub duration_ms: Option<u64>,
}

pub(crate) const DOCX_MEDIA_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sniffed {
    Pdf,
    Zip,
    Png,
    Jpeg,
    Gif,
    Webp,
    Mp3,
    /// ISO base media (MP4/M4A): `ftyp` box first.
    IsoMedia,
    Wav,
    Other,
}

fn sniff(bytes: &[u8]) -> Sniffed {
    // Some producers put a few bytes before the header; readers tolerate up to 1 KiB.
    let head = &bytes[..bytes.len().min(1024)];
    if bytes.starts_with(b"%PDF-") || head.windows(5).any(|w| w == b"%PDF-") {
        Sniffed::Pdf
    } else if bytes.starts_with(b"PK\x03\x04") {
        Sniffed::Zip
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Sniffed::Png
    } else if bytes.starts_with(b"\xFF\xD8\xFF") {
        Sniffed::Jpeg
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Sniffed::Gif
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Sniffed::Webp
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        Sniffed::Wav
    } else if bytes.len() >= 8 && &bytes[4..8] == b"ftyp" {
        Sniffed::IsoMedia
    } else if bytes.starts_with(b"ID3") || is_mp3_frame_sync(bytes) {
        Sniffed::Mp3
    } else {
        Sniffed::Other
    }
}

/// MPEG audio layer III frame header at offset 0 (files without an ID3 tag).
fn is_mp3_frame_sync(bytes: &[u8]) -> bool {
    bytes.len() >= 4
        && bytes[0] == 0xFF
        && bytes[1] & 0xE0 == 0xE0
        // Version not "reserved", layer III, bitrate and sample rate not "bad"/"reserved".
        && (bytes[1] >> 3) & 0b11 != 0b01
        && (bytes[1] >> 1) & 0b11 == 0b01
        && bytes[2] >> 4 != 0b1111
        && (bytes[2] >> 2) & 0b11 != 0b11
}

/// Bytes needed to recognise any supported format from its signature.
pub(crate) const SNIFF_BYTES: usize = 1024;

/// Lowercase extension of `file_name` (after the last dot), if any.
pub(crate) fn extension(file_name: &str) -> Option<String> {
    let (stem, ext) = file_name.rsplit_once('.')?;
    if stem.is_empty() || ext.is_empty() {
        return None;
    }
    Some(ext.to_lowercase())
}

fn mismatch(what: &str) -> CoreError {
    CoreError::unsupported(format!(
        "Formato non supportato: il contenuto del file non è {what}."
    ))
}

/// Recognizes the format of a non-empty file from its name and content.
/// Audio/video are probed from an in-memory copy (files received whole are at most
/// [`IMPORT_MAX_BYTES`]; large media go through [`detect_media_file`]).
pub fn detect_format(file_name: &str, bytes: &[u8]) -> Result<DetectedFormat> {
    let Some(ext) = extension(file_name) else {
        return Err(CoreError::unsupported(NO_EXTENSION));
    };
    if let Some(expected) = media_signature(&ext) {
        check_media_signature(&ext, expected, sniff(bytes))?;
        let source = Box::new(std::io::Cursor::new(bytes.to_vec()));
        return media_format(&ext, probe(source, &ext));
    }
    let sniffed = sniff(bytes);
    let image = |expected: Sniffed, media_type: &'static str, what: &str| {
        if sniffed != expected {
            return Err(mismatch(what));
        }
        let size = imagesize::blob_size(bytes).map_err(|_| {
            CoreError::unsupported(
                "Formato non supportato: l'immagine è danneggiata o illeggibile.",
            )
        })?;
        let width = u32::try_from(size.width).unwrap_or(u32::MAX);
        let height = u32::try_from(size.height).unwrap_or(u32::MAX);
        Ok(DetectedFormat {
            kind: DocumentKind::Image,
            media_type,
            image_size: Some((width, height)),
            duration_ms: None,
        })
    };
    match ext.as_str() {
        "pdf" => {
            if sniffed != Sniffed::Pdf {
                return Err(mismatch("un PDF"));
            }
            Ok(DetectedFormat {
                kind: DocumentKind::Pdf,
                media_type: "application/pdf",
                image_size: None,
                duration_ms: None,
            })
        }
        "docx" => {
            if sniffed != Sniffed::Zip || !zip_has_document_xml(bytes) {
                return Err(mismatch("un documento Word (.docx)"));
            }
            Ok(DetectedFormat {
                kind: DocumentKind::Docx,
                media_type: DOCX_MEDIA_TYPE,
                image_size: None,
                duration_ms: None,
            })
        }
        "txt" | "md" | "markdown" => {
            let (kind, media_type) = if ext == "txt" {
                (DocumentKind::Text, "text/plain")
            } else {
                (DocumentKind::Markdown, "text/markdown")
            };
            let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
            // `%PDF-` is tolerated anywhere in the first KiB only to recognise PDFs; a text file
            // that merely mentions it is still text. Binary signatures at offset 0 are not.
            // ID3/ftyp signatures are plain ASCII a text could start with: real audio files
            // renamed to .txt are still refused by the UTF-8 check below.
            let binary_signature = match sniffed {
                Sniffed::Other | Sniffed::Mp3 | Sniffed::IsoMedia => false,
                Sniffed::Pdf => body.starts_with(b"%PDF-"),
                _ => true,
            };
            if binary_signature {
                return Err(mismatch("un file di testo"));
            }
            if std::str::from_utf8(body).is_err() || body.contains(&0) {
                return Err(CoreError::unsupported(
                    "Formato non supportato: il file di testo deve essere in UTF-8.",
                ));
            }
            Ok(DetectedFormat {
                kind,
                media_type,
                image_size: None,
                duration_ms: None,
            })
        }
        "png" => image(Sniffed::Png, "image/png", "un'immagine PNG"),
        "jpg" | "jpeg" => image(Sniffed::Jpeg, "image/jpeg", "un'immagine JPEG"),
        "gif" => image(Sniffed::Gif, "image/gif", "un'immagine GIF"),
        "webp" => image(Sniffed::Webp, "image/webp", "un'immagine WebP"),
        _ => Err(unknown_extension(&ext)),
    }
}

/// Recognizes an audio/video file stored at `path` (signature, then container probe for
/// duration and video size, reading only what the container needs). `Ok(None)` when the
/// extension is not an audio/video one.
pub fn detect_media_file(
    file_name: &str,
    path: &std::path::Path,
) -> Result<Option<DetectedFormat>> {
    let Some(ext) = extension(file_name) else {
        return Err(CoreError::unsupported(NO_EXTENSION));
    };
    let Some(expected) = media_signature(&ext) else {
        return Ok(None);
    };
    let read_err = |err: std::io::Error| {
        CoreError::storage(
            "Impossibile leggere il file caricato.",
            format!("{}: {err}", path.display()),
        )
    };
    let mut file = std::fs::File::open(path).map_err(read_err)?;
    let mut head = Vec::with_capacity(SNIFF_BYTES);
    std::io::Read::by_ref(&mut file)
        .take(SNIFF_BYTES as u64)
        .read_to_end(&mut head)
        .map_err(read_err)?;
    check_media_signature(&ext, expected, sniff(&head))?;
    let file = std::fs::File::open(path).map_err(read_err)?;
    media_format(&ext, probe(Box::new(file), &ext)).map(Some)
}

/// Expected signature for audio/video extensions.
fn media_signature(ext: &str) -> Option<Sniffed> {
    Some(match ext {
        "mp3" => Sniffed::Mp3,
        "m4a" | "mp4" => Sniffed::IsoMedia,
        "wav" => Sniffed::Wav,
        _ => return None,
    })
}

fn check_media_signature(ext: &str, expected: Sniffed, sniffed: Sniffed) -> Result<()> {
    if sniffed == expected {
        return Ok(());
    }
    Err(mismatch(match ext {
        "mp3" => "un audio MP3",
        "m4a" => "un audio M4A",
        "wav" => "un audio WAV",
        _ => "un video MP4",
    }))
}

fn media_format(
    ext: &str,
    probed: std::result::Result<MediaInfo, String>,
) -> Result<DetectedFormat> {
    let (kind, media_type) = match ext {
        "mp3" => (DocumentKind::Audio, "audio/mpeg"),
        "m4a" => (DocumentKind::Audio, "audio/mp4"),
        "wav" => (DocumentKind::Audio, "audio/wav"),
        _ => (DocumentKind::Video, "video/mp4"),
    };
    let info = probed.map_err(|_| {
        CoreError::unsupported(if kind == DocumentKind::Video {
            "Formato non supportato: il video è danneggiato o illeggibile."
        } else {
            "Formato non supportato: l'audio è danneggiato o illeggibile."
        })
    })?;
    if kind == DocumentKind::Audio && !info.has_audio_track {
        return Err(CoreError::unsupported(
            "Formato non supportato: il file non contiene una traccia audio.",
        ));
    }
    Ok(DetectedFormat {
        kind,
        media_type,
        image_size: if kind == DocumentKind::Video {
            info.video_size
        } else {
            None
        },
        duration_ms: info.duration_ms,
    })
}

fn zip_has_document_xml(bytes: &[u8]) -> bool {
    zip::ZipArchive::new(Cursor::new(bytes))
        .map(|archive| archive.index_for_name("word/document.xml").is_some())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_rules() {
        assert_eq!(extension("a.PDF").as_deref(), Some("pdf"));
        assert_eq!(extension("archivio.tar.md").as_deref(), Some("md"));
        assert_eq!(extension(".bashrc"), None);
        assert_eq!(extension("senza"), None);
        assert_eq!(extension("punto."), None);
    }

    #[test]
    fn kind_round_trip() {
        for kind in [
            DocumentKind::Pdf,
            DocumentKind::Text,
            DocumentKind::Markdown,
            DocumentKind::Docx,
            DocumentKind::Image,
            DocumentKind::Audio,
            DocumentKind::Video,
        ] {
            assert_eq!(DocumentKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(DocumentKind::parse("exe"), None);
    }

    #[test]
    fn text_with_bom_is_accepted_binary_is_not() {
        assert!(detect_format("a.txt", b"\xEF\xBB\xBFciao").is_ok());
        assert!(matches!(
            detect_format("a.txt", b"ciao\0mondo"),
            Err(CoreError::Unsupported { .. })
        ));
        assert!(matches!(
            detect_format("a.md", b"\xff\xfe"),
            Err(CoreError::Unsupported { .. })
        ));
        assert!(matches!(
            detect_format("a.txt", b"%PDF-1.4 fake"),
            Err(CoreError::Unsupported { .. })
        ));
    }
}

#[cfg(test)]
mod pdf_marker_tests {
    use super::*;

    #[test]
    fn text_mentioning_pdf_marker_is_still_text() {
        let f =
            detect_format("nota.txt", "Nota con %PDF-1.4 citato nel testo.".as_bytes()).unwrap();
        assert_eq!(f.kind, DocumentKind::Text);
        let f = detect_format("nota.md", b"# Titolo\n\nVedi %PDF-1.7.").unwrap();
        assert_eq!(f.kind, DocumentKind::Markdown);
    }

    #[test]
    fn pdf_renamed_to_txt_is_rejected_as_mismatch() {
        let err = detect_format("finto.txt", b"%PDF-1.4\n%...").unwrap_err();
        assert!(err.to_string().contains("non è un file di testo"), "{err}");
    }
}
