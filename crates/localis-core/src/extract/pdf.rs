//! PDF: text per page, decoded with the page fonts' encodings (ToUnicode CMaps included).
//! Text is read from page content streams only (not from form XObjects); there is no
//! OCR, so a scanned PDF yields no units.

use std::collections::BTreeMap;

use lopdf::content::Content;
use lopdf::{Document, Encoding, LoadOptions, Object};

use super::{clean_unit, ExtractError, ExtractResult, Extracted};

/// Bound on any single decompressed stream while loading and per page content.
const MAX_DECOMPRESSED: usize = 64 * 1024 * 1024;
const UNREADABLE: &str = "Il PDF non può essere letto: potrebbe essere danneggiato.";
const PROTECTED: &str = "Il PDF è protetto da password: impossibile estrarne il testo.";

pub(super) fn extract(bytes: &[u8]) -> ExtractResult {
    let options = LoadOptions {
        // Many PDFs are encrypted with an empty user password (owner restrictions only).
        password: Some(String::new()),
        max_decompressed_size: Some(MAX_DECOMPRESSED),
        ..LoadOptions::default()
    };
    let doc = Document::load_mem_with_options(bytes, options).map_err(|err| match err {
        lopdf::Error::InvalidPassword | lopdf::Error::Decryption(_) => {
            ExtractError::new(PROTECTED, err)
        }
        other => ExtractError::new(UNREADABLE, other),
    })?;
    let pages = doc.get_pages();
    if pages.is_empty() {
        return Err(ExtractError::new(UNREADABLE, "no pages found"));
    }
    let page_count = u32::try_from(pages.len()).unwrap_or(u32::MAX);

    let mut units = Vec::new();
    let mut failures = Vec::new();
    for (&number, &page_id) in &pages {
        match page_text(&doc, page_id) {
            Ok(text) => {
                let text = clean_unit(&text);
                if !text.is_empty() {
                    units.push((number, text));
                }
            }
            Err(err) => failures.push(format!("page {number}: {err}")),
        }
    }
    // Pages that cannot be decoded are skipped; if none could, the file is unreadable.
    if failures.len() == pages.len() {
        return Err(ExtractError::new(UNREADABLE, failures.join("; ")));
    }
    Ok(Extracted {
        units,
        page_count: Some(page_count),
    })
}

fn page_text(doc: &Document, page_id: lopdf::ObjectId) -> lopdf::Result<String> {
    let fonts = doc.get_page_fonts(page_id)?;
    let encodings: BTreeMap<Vec<u8>, Encoding> = fonts
        .into_iter()
        .filter_map(|(name, font)| {
            font.get_font_encoding_with_limit(doc, MAX_DECOMPRESSED)
                .ok()
                .map(|e| (name, e))
        })
        .collect();
    let data = doc.get_page_content_with_limit(page_id, MAX_DECOMPRESSED)?;
    let content = Content::decode(&data)?;

    let mut out = String::new();
    let mut encoding: Option<&Encoding> = None;
    let mut last_tm_y: Option<f32> = None;
    for op in &content.operations {
        let operands = &op.operands;
        match op.operator.as_str() {
            "Tf" => {
                encoding = operands
                    .first()
                    .and_then(|o| o.as_name().ok())
                    .and_then(|name| encodings.get(name));
            }
            "Tj" => show(&mut out, encoding, operands.first()),
            "'" => {
                newline(&mut out);
                show(&mut out, encoding, operands.first());
            }
            "\"" => {
                newline(&mut out);
                show(&mut out, encoding, operands.get(2));
            }
            "TJ" => {
                if let Some(Object::Array(items)) = operands.first() {
                    for item in items {
                        match item {
                            Object::String(..) => show(&mut out, encoding, Some(item)),
                            // A large negative adjustment (thousandths of em) is a word gap.
                            other => {
                                if other.as_float().is_ok_and(|v| v < -200.0) {
                                    space(&mut out);
                                }
                            }
                        }
                    }
                }
            }
            "Td" | "TD" => {
                let ty = operands
                    .get(1)
                    .and_then(|o| o.as_float().ok())
                    .unwrap_or(0.0);
                if ty.abs() > 0.01 {
                    newline(&mut out);
                } else {
                    space(&mut out);
                }
            }
            "Tm" => {
                let y = operands.get(5).and_then(|o| o.as_float().ok());
                match (last_tm_y, y) {
                    (Some(prev), Some(y)) if (prev - y).abs() <= 0.01 => space(&mut out),
                    _ => newline(&mut out),
                }
                last_tm_y = y;
            }
            "T*" | "ET" => newline(&mut out),
            _ => {}
        }
    }
    Ok(out)
}

fn show(out: &mut String, encoding: Option<&Encoding>, operand: Option<&Object>) {
    if let (Some(encoding), Some(Object::String(bytes, _))) = (encoding, operand) {
        // Undecodable strings are skipped rather than failing the page.
        let _ = encoding.write_to_string(bytes, out);
    }
}

fn newline(out: &mut String) {
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
}

fn space(out: &mut String) {
    if !out.is_empty() && !out.ends_with(char::is_whitespace) {
        out.push(' ');
    }
}
