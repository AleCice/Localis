//! DOCX: paragraphs of `word/document.xml` (`w:t` text, `w:tab` → tab, `w:br`/`w:cr` →
//! newline). Each non-empty paragraph is a block.

use std::io::{Cursor, Read};

use quick_xml::events::Event;
use quick_xml::name::ResolveResult;
use quick_xml::NsReader;

use super::{number_units, ExtractError, ExtractResult, Extracted};

const W_NS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MC_NS: &str = "http://schemas.openxmlformats.org/markup-compatibility/2006";
/// Upper bound on the uncompressed size of `word/document.xml` (zip-bomb guard).
const MAX_DOCUMENT_XML: u64 = 256 * 1024 * 1024;
const UNREADABLE: &str = "Il documento Word non può essere letto: potrebbe essere danneggiato.";

pub(super) fn extract(bytes: &[u8]) -> ExtractResult {
    let xml = read_document_xml(bytes)?;
    let paragraphs = paragraphs(&xml).map_err(|detail| ExtractError::new(UNREADABLE, detail))?;
    Ok(Extracted {
        units: number_units(paragraphs),
        page_count: None,
    })
}

fn read_document_xml(bytes: &[u8]) -> Result<String, ExtractError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|err| ExtractError::new(UNREADABLE, format!("zip: {err}")))?;
    let entry = archive
        .by_name("word/document.xml")
        .map_err(|err| ExtractError::new(UNREADABLE, format!("word/document.xml: {err}")))?;
    let mut data = Vec::new();
    entry
        .take(MAX_DOCUMENT_XML + 1)
        .read_to_end(&mut data)
        .map_err(|err| ExtractError::new(UNREADABLE, format!("word/document.xml: {err}")))?;
    if data.len() as u64 > MAX_DOCUMENT_XML {
        return Err(ExtractError::new(
            "Il documento Word è troppo grande per estrarne il testo.",
            format!("word/document.xml larger than {MAX_DOCUMENT_XML} bytes"),
        ));
    }
    String::from_utf8(data).map_err(|err| {
        ExtractError::new(UNREADABLE, format!("word/document.xml is not UTF-8: {err}"))
    })
}

fn paragraphs(xml: &str) -> Result<Vec<String>, String> {
    let mut reader = NsReader::from_str(xml);
    // Paragraph buffers: text boxes nest paragraphs inside runs of an outer paragraph.
    let mut stack: Vec<String> = Vec::new();
    let mut out = Vec::new();
    let mut run_depth = 0usize;
    let mut in_text = 0usize;
    // Inside `mc:Fallback` (duplicate rendering of `mc:Choice` content): skipped.
    let mut fallback_depth = 0usize;

    loop {
        let (ns, event) = reader
            .read_resolved_event()
            .map_err(|err| format!("xml: {err}"))?;
        let is_w = matches!(ns, ResolveResult::Bound(n) if n.as_ref() == W_NS);
        let is_mc = matches!(ns, ResolveResult::Bound(n) if n.as_ref() == MC_NS);
        match event {
            Event::Start(e) => {
                let local = e.local_name();
                if is_mc && local.as_ref() == "Fallback" {
                    fallback_depth += 1;
                } else if fallback_depth == 0 && is_w {
                    match local.as_ref() {
                        "p" => stack.push(String::new()),
                        "r" => run_depth += 1,
                        "t" if run_depth > 0 => in_text += 1,
                        _ => {}
                    }
                }
            }
            Event::Empty(e) => {
                // `<w:p/>` is an empty paragraph: nothing to emit. Tab stops in `w:pPr`
                // are outside runs and ignored.
                if fallback_depth == 0 && is_w && run_depth > 0 {
                    if let Some(current) = stack.last_mut() {
                        match e.local_name().as_ref() {
                            "tab" => current.push('\t'),
                            "br" | "cr" => current.push('\n'),
                            _ => {}
                        }
                    }
                }
            }
            Event::End(e) => {
                let local = e.local_name();
                if is_mc && local.as_ref() == "Fallback" {
                    fallback_depth = fallback_depth.saturating_sub(1);
                } else if fallback_depth == 0 && is_w {
                    match local.as_ref() {
                        "p" => {
                            if let Some(done) = stack.pop() {
                                out.push(done);
                            }
                        }
                        "r" => run_depth = run_depth.saturating_sub(1),
                        "t" => in_text = in_text.saturating_sub(1),
                        _ => {}
                    }
                }
            }
            Event::Text(t) if in_text > 0 && fallback_depth == 0 => {
                if let Some(current) = stack.last_mut() {
                    current.push_str(&t.xml10_content());
                }
            }
            Event::CData(t) if in_text > 0 && fallback_depth == 0 => {
                if let Some(current) = stack.last_mut() {
                    current.push_str(&t.xml10_content());
                }
            }
            Event::GeneralRef(r) if in_text > 0 && fallback_depth == 0 => {
                let resolved = match r.resolve_char_ref() {
                    Ok(Some(c)) => Some(c),
                    Ok(None) => match r.as_ref() {
                        "amp" => Some('&'),
                        "lt" => Some('<'),
                        "gt" => Some('>'),
                        "quot" => Some('"'),
                        "apos" => Some('\''),
                        _ => None,
                    },
                    Err(_) => None,
                };
                if let (Some(c), Some(current)) = (resolved, stack.last_mut()) {
                    current.push(c);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(body: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>{body}</w:body></w:document>"#
        )
    }

    #[test]
    fn paragraphs_tabs_breaks_and_entities() {
        let xml = doc(concat!(
            r#"<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>"#,
            r#"<w:r><w:t>Uno</w:t><w:tab/><w:t xml:space="preserve">due </w:t></w:r>"#,
            r#"<w:r><w:t>&amp; tre&#33;</w:t><w:br/><w:t>riga</w:t></w:r></w:p>"#,
            r#"<w:p/><w:p><w:r><w:t>   </w:t></w:r></w:p>"#,
            r#"<w:p><w:r><w:delText>cancellato</w:delText><w:t>Città</w:t></w:r></w:p>"#,
        ));
        let paragraphs = paragraphs(&xml).unwrap();
        let units = number_units(paragraphs);
        assert_eq!(
            units,
            vec![
                (1, "Uno\tdue & tre!\nriga".to_owned()),
                (2, "Città".to_owned())
            ]
        );
    }

    #[test]
    fn fallback_content_is_not_duplicated() {
        let xml = doc(concat!(
            r#"<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps">"#,
            r#"<w:txbxContent><w:p><w:r><w:t>Casella</w:t></w:r></w:p></w:txbxContent>"#,
            r#"</mc:Choice><mc:Fallback><w:txbxContent><w:p><w:r><w:t>Casella</w:t></w:r></w:p>"#,
            r#"</w:txbxContent></mc:Fallback></mc:AlternateContent></w:r><w:r><w:t>Fuori</w:t></w:r></w:p>"#,
        ));
        let units = number_units(paragraphs(&xml).unwrap());
        assert_eq!(
            units,
            vec![(1, "Casella".to_owned()), (2, "Fuori".to_owned())]
        );
    }

    #[test]
    fn malformed_xml_is_an_error() {
        assert!(paragraphs("<w:document><w:body><w:p></w:body>").is_err());
    }

    #[test]
    fn not_a_zip_fails() {
        assert!(extract(b"PK\x03\x04garbage").is_err());
    }
}
