//! Plain text and Markdown: raw text split into blocks separated by blank lines.

use super::{number_units, ExtractError, ExtractResult, Extracted};

pub(super) fn extract(bytes: &[u8]) -> ExtractResult {
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let text = std::str::from_utf8(body)
        .map_err(|err| ExtractError::new("Il file di testo non è in UTF-8 valido.", err))?;
    Ok(Extracted {
        units: number_units(split_blocks(text)),
        page_count: None,
    })
}

/// Splits on lines that are empty or whitespace only; CRLF and CR count as newlines.
fn split_blocks(text: &str) -> Vec<String> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut blocks = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    for line in normalized.split('\n') {
        if line.trim().is_empty() {
            if !current.is_empty() {
                blocks.push(current.join("\n"));
                current.clear();
            }
        } else {
            current.push(line);
        }
    }
    if !current.is_empty() {
        blocks.push(current.join("\n"));
    }
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_split_on_blank_lines() {
        let out = extract(
            "\u{feff}# Titolo\r\n\r\nPrimo paragrafo\nsu due righe\n \t \n\n\nSecondo".as_bytes(),
        )
        .unwrap();
        assert_eq!(
            out.units,
            vec![
                (1, "# Titolo".to_owned()),
                (2, "Primo paragrafo\nsu due righe".to_owned()),
                (3, "Secondo".to_owned()),
            ]
        );
    }

    #[test]
    fn whitespace_only_has_no_units() {
        assert!(extract(b"  \n\n\t").unwrap().units.is_empty());
        assert!(extract(b"").unwrap().units.is_empty());
    }

    #[test]
    fn invalid_utf8_fails() {
        assert!(extract(b"\xff\xfe").is_err());
    }
}
