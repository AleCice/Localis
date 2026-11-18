//! Format recognition for imported files: magic bytes plus extension, which must agree.

use std::io::Cursor;

use crate::error::{CoreError, Result};

/// Kind of document, as exposed to the UI (`DocumentKind` in `src/api/types.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DocumentKind {
    Pdf,
    Text,
    Markdown,
    Docx,
    Image,
}

impl DocumentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DocumentKind::Pdf => "pdf",
            DocumentKind::Text => "text",
            DocumentKind::Markdown => "markdown",
            DocumentKind::Docx => "docx",
            DocumentKind::Image => "image",
        }
    }

    pub(crate) fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "pdf" => DocumentKind::Pdf,
            "text" => DocumentKind::Text,
            "markdown" => DocumentKind::Markdown,
            "docx" => DocumentKind::Docx,
            "image" => DocumentKind::Image,
            _ => return None,
        })
    }

    /// Whether this kind gets a text-extraction job.
    pub fn has_text(self) -> bool {
        self != DocumentKind::Image
    }
}

/// Result of format recognition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedFormat {
    pub kind: DocumentKind,
    pub media_type: &'static str,
    /// Pixel dimensions, images only.
    pub image_size: Option<(u32, u32)>,
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
    } else {
        Sniffed::Other
    }
}

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
pub fn detect_format(file_name: &str, bytes: &[u8]) -> Result<DetectedFormat> {
    let Some(ext) = extension(file_name) else {
        return Err(CoreError::unsupported(
            "Formato non supportato: il file non ha un'estensione riconoscibile.",
        ));
    };
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
            let binary_signature = match sniffed {
                Sniffed::Other => false,
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
            })
        }
        "png" => image(Sniffed::Png, "image/png", "un'immagine PNG"),
        "jpg" | "jpeg" => image(Sniffed::Jpeg, "image/jpeg", "un'immagine JPEG"),
        "gif" => image(Sniffed::Gif, "image/gif", "un'immagine GIF"),
        "webp" => image(Sniffed::Webp, "image/webp", "un'immagine WebP"),
        _ => Err(CoreError::unsupported(format!(
            "Formato non supportato: .{}",
            ext.chars().take(20).collect::<String>()
        ))),
    }
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
