//! Passages ("chunks") derived from the extracted text, used by chat retrieval.
//! Each text unit (PDF page or text block) is split into passages of at most
//! [`CHUNK_MAX_CHARS`] characters on paragraph or sentence boundaries, never in the middle of
//! a word unless a single word is longer than the limit.

use rusqlite::{params, Transaction, TransactionBehavior};

use crate::error::Result;
use crate::store::Store;

/// Max characters (Unicode scalar values) of a passage.
pub const CHUNK_MAX_CHARS: usize = 1200;
/// A break is looked for only after this many characters, so passages are not tiny.
const CHUNK_MIN_CHARS: usize = 400;

/// One passage of a unit. Offsets are in characters (Unicode scalar values) of the unit text,
/// `char_end` exclusive; `text` is exactly that slice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkSpan {
    pub ordinal: u32,
    pub char_start: usize,
    pub char_end: usize,
    pub text: String,
}

/// Splits the text of one unit into passages (empty input → no passages).
pub fn chunk_text(text: &str) -> Vec<ChunkSpan> {
    let chars: Vec<char> = text.chars().collect();
    let mut spans = Vec::new();
    let mut start = skip_space(&chars, 0);
    while start < chars.len() {
        let limit = start + CHUNK_MAX_CHARS;
        let end = if limit >= chars.len() {
            chars.len()
        } else {
            find_break(&chars, start, limit)
        };
        // Trim trailing whitespace from the passage.
        let mut stop = end;
        while stop > start && chars[stop - 1].is_whitespace() {
            stop -= 1;
        }
        if stop > start {
            spans.push(ChunkSpan {
                ordinal: spans.len() as u32 + 1,
                char_start: start,
                char_end: stop,
                text: chars[start..stop].iter().collect(),
            });
        }
        start = skip_space(&chars, end.max(start + 1));
    }
    spans
}

fn skip_space(chars: &[char], mut i: usize) -> usize {
    while i < chars.len() && chars[i].is_whitespace() {
        i += 1;
    }
    i
}

/// Best end (exclusive) for a passage starting at `start` that must not pass `limit`
/// (`limit < chars.len()`): paragraph break, then line break, then sentence end, then any
/// whitespace; a hard cut only when the window holds a single word.
fn find_break(chars: &[char], start: usize, limit: usize) -> usize {
    let lo = start + CHUNK_MIN_CHARS.min(CHUNK_MAX_CHARS / 3);
    // Position `i` is a candidate end: the passage is chars[start..i].
    let candidates = |pred: &dyn Fn(usize) -> bool| (lo..=limit).rev().find(|&i| pred(i));
    let is_ws = |i: usize| i < chars.len() && chars[i].is_whitespace();
    let paragraph = |i: usize| chars[i] == '\n' && i + 1 < chars.len() && chars[i + 1] == '\n';
    if let Some(i) = candidates(&|i| i < chars.len() && paragraph(i)) {
        return i;
    }
    if let Some(i) = candidates(&|i| i < chars.len() && chars[i] == '\n') {
        return i;
    }
    if let Some(i) =
        candidates(&|i| is_ws(i) && i > 0 && matches!(chars[i - 1], '.' | '!' | '?' | ';' | ':'))
    {
        return i;
    }
    if let Some(i) = (start + 1..=limit).rev().find(|&i| is_ws(i)) {
        return i;
    }
    limit
}

/// Replaces the passages of a version with those derived from `units` (unit, text).
pub(crate) fn replace_chunks(
    tx: &Transaction<'_>,
    version_id: &str,
    units: &[(u32, String)],
) -> Result<usize> {
    tx.execute(
        "DELETE FROM chunks WHERE version_id = ?1",
        params![version_id],
    )?;
    let mut insert = tx.prepare(
        "INSERT INTO chunks (version_id, unit, ordinal, char_start, char_end, text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    let mut count = 0;
    for (unit, text) in units {
        for span in chunk_text(text) {
            insert.execute(params![
                version_id,
                unit,
                span.ordinal,
                span.char_start as i64,
                span.char_end as i64,
                span.text
            ])?;
            count += 1;
        }
    }
    Ok(count)
}

impl Store {
    /// Creates the passages of versions whose text was extracted before passages existed
    /// (databases from 0.2). Idempotent: versions that already have passages are skipped.
    /// Returns the number of versions processed.
    pub fn backfill_chunks(&mut self) -> Result<usize> {
        let versions: Vec<String> = {
            let mut stmt = self.conn.prepare(
                "SELECT v.id FROM document_versions v
                 WHERE v.text_status = 'extracted'
                   AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.version_id = v.id)
                 ORDER BY v.imported_at, v.id",
            )?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let mut done = 0;
        for version_id in versions {
            let tx = self
                .conn
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let pending: bool = tx.query_row(
                "SELECT text_status = 'extracted'
                        AND NOT EXISTS (SELECT 1 FROM chunks WHERE version_id = ?1)
                 FROM document_versions WHERE id = ?1",
                params![version_id],
                |r| r.get(0),
            )?;
            if pending {
                let units: Vec<(u32, String)> = {
                    let mut stmt = tx.prepare(
                        "SELECT unit, text FROM document_text WHERE version_id = ?1 ORDER BY unit",
                    )?;
                    let rows =
                        stmt.query_map(params![version_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
                    rows.collect::<rusqlite::Result<_>>()?
                };
                replace_chunks(&tx, &version_id, &units)?;
                done += 1;
            }
            tx.commit()?;
        }
        Ok(done)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check_invariants(text: &str, spans: &[ChunkSpan]) {
        let chars: Vec<char> = text.chars().collect();
        let mut prev_end = 0;
        for (i, s) in spans.iter().enumerate() {
            assert_eq!(s.ordinal as usize, i + 1);
            assert!(s.char_start >= prev_end);
            assert!(s.char_end > s.char_start);
            assert!(s.char_end - s.char_start <= CHUNK_MAX_CHARS);
            let slice: String = chars[s.char_start..s.char_end].iter().collect();
            assert_eq!(slice, s.text);
            assert_eq!(s.text.trim(), s.text);
            prev_end = s.char_end;
        }
        // Nothing but whitespace is lost.
        let joined: String = spans.iter().map(|s| s.text.as_str()).collect();
        let strip = |t: &str| t.chars().filter(|c| !c.is_whitespace()).collect::<String>();
        assert_eq!(strip(&joined), strip(text));
    }

    #[test]
    fn short_and_empty_units() {
        assert!(chunk_text("").is_empty());
        assert!(chunk_text("   \n ").is_empty());
        let spans = chunk_text("  Una frase breve.  ");
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].text, "Una frase breve.");
        assert_eq!((spans[0].char_start, spans[0].char_end), (2, 18));
    }

    #[test]
    fn exactly_max_is_one_chunk() {
        let text = "a".repeat(CHUNK_MAX_CHARS);
        let spans = chunk_text(&text);
        assert_eq!(spans.len(), 1);
        check_invariants(&text, &spans);
    }

    #[test]
    fn splits_on_paragraphs_first() {
        let para = "Parola ".repeat(100); // 700 chars
        let text = format!("{}\n\n{}\n\n{}", para.trim(), para.trim(), para.trim());
        let spans = chunk_text(&text);
        assert_eq!(spans.len(), 3);
        assert!(spans.iter().all(|s| s.text == para.trim()));
        check_invariants(&text, &spans);
    }

    #[test]
    fn splits_on_sentences_never_mid_word() {
        let sentence = "La città di Pisa è antica e ha una torre pendente. "; // accents: chars ≠ bytes
        let text = sentence.repeat(60);
        let spans = chunk_text(&text);
        assert!(spans.len() >= 3);
        check_invariants(&text, &spans);
        for s in &spans {
            assert!(s.text.ends_with('.'), "{:?}", &s.text[s.text.len() - 10..]);
            assert!(s.text.starts_with("La"));
        }
    }

    #[test]
    fn falls_back_to_whitespace_then_hard_cut() {
        let text = "parola ".repeat(400);
        let spans = chunk_text(&text);
        check_invariants(&text, &spans);
        assert!(spans.iter().all(|s| s.text.ends_with("parola")));
        let long_word = "x".repeat(CHUNK_MAX_CHARS * 2 + 5);
        let spans = chunk_text(&long_word);
        assert_eq!(spans.len(), 3);
        check_invariants(&long_word, &spans);
    }
}
