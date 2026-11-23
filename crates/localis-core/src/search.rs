//! Full-text search (FTS5) over the extracted text of the current versions of a project.

use rusqlite::params;

use crate::error::Result;
use crate::formats::DocumentKind;
use crate::store::Store;

pub const SEARCH_DEFAULT_LIMIT: u32 = 50;
pub const SEARCH_MAX_LIMIT: u32 = 200;
/// Snippet markers around matched terms (`SNIPPET_MARK_START/END` in `src/api/types.ts`).
pub const SNIPPET_MARK_START: &str = "\u{2}";
pub const SNIPPET_MARK_END: &str = "\u{3}";
const SNIPPET_ELLIPSIS: &str = "…";
const SNIPPET_TOKENS: i64 = 14;
const MAX_QUERY_TOKENS: usize = 32;
const MAX_TOKEN_CHARS: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnitKind {
    /// PDF page.
    Page,
    /// Text block or paragraph.
    Block,
    /// v0.5: transcript segment of an audio/video (unit = 1-based segment index).
    Segment,
}

impl UnitKind {
    pub fn as_str(self) -> &'static str {
        match self {
            UnitKind::Page => "page",
            UnitKind::Block => "block",
            UnitKind::Segment => "segment",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "page" => UnitKind::Page,
            "block" => UnitKind::Block,
            "segment" => UnitKind::Segment,
            _ => return None,
        })
    }

    /// Unit kind of the text of a document kind (stored as text).
    pub(crate) fn for_kind(kind: &str) -> Self {
        match DocumentKind::parse(kind) {
            Some(DocumentKind::Pdf) => UnitKind::Page,
            Some(DocumentKind::Audio | DocumentKind::Video) => UnitKind::Segment,
            _ => UnitKind::Block,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub document_id: String,
    pub version_id: String,
    pub title: String,
    pub folder_id: Option<String>,
    pub unit: u32,
    pub unit_kind: UnitKind,
    /// Plain text excerpt; matched terms wrapped in U+0002 … U+0003.
    pub snippet: String,
    /// v0.5: start of the segment, for `Segment` hits.
    pub start_ms: Option<u64>,
}

/// Builds a safe FTS5 query from user input: words only (never FTS syntax), each quoted,
/// all required (AND), the last one as a prefix. `None` when there are no words.
pub fn fts_query(input: &str) -> Option<String> {
    let is_word_char = |c: char| c.is_alphanumeric() || ('\u{300}'..='\u{36f}').contains(&c);
    let tokens: Vec<String> = input
        .split(|c: char| !is_word_char(c))
        .filter(|t| !t.is_empty())
        .take(MAX_QUERY_TOKENS)
        .map(|t| t.chars().take(MAX_TOKEN_CHARS).collect::<String>())
        .collect();
    let last = tokens.len().checked_sub(1)?;
    let parts: Vec<String> = tokens
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let quoted = format!("\"{}\"", t.replace('"', "\"\""));
            if i == last {
                quoted + "*"
            } else {
                quoted
            }
        })
        .collect();
    Some(parts.join(" "))
}

impl Store {
    /// Searches the current versions of the project's documents, best matches first.
    /// `limit` defaults to 50 and is capped at 200.
    pub fn search(
        &self,
        project_id: &str,
        query: &str,
        limit: Option<u32>,
    ) -> Result<Vec<SearchHit>> {
        self.ensure_project(project_id)?;
        let Some(fts) = fts_query(query) else {
            return Ok(Vec::new());
        };
        let limit = limit
            .unwrap_or(SEARCH_DEFAULT_LIMIT)
            .clamp(1, SEARCH_MAX_LIMIT);
        let mut stmt = self.conn.prepare(
            "SELECT d.id, v.id, d.title, d.folder_id, t.unit, v.kind,
                    snippet(document_text_fts, 0, ?3, ?4, ?5, ?6),
                    (SELECT s.start_ms FROM transcript_segments s
                     WHERE s.version_id = t.version_id AND s.idx = t.unit)
             FROM document_text_fts
             JOIN document_text t ON t.id = document_text_fts.rowid
             JOIN document_versions v ON v.id = t.version_id
             JOIN documents d ON d.id = v.document_id
             WHERE document_text_fts MATCH ?1
               AND d.project_id = ?2
               AND v.version_no = (SELECT MAX(m.version_no) FROM document_versions m
                                   WHERE m.document_id = d.id)
             ORDER BY bm25(document_text_fts), d.title, t.unit
             LIMIT ?7",
        )?;
        let rows = stmt.query_map(
            params![
                fts,
                project_id,
                SNIPPET_MARK_START,
                SNIPPET_MARK_END,
                SNIPPET_ELLIPSIS,
                SNIPPET_TOKENS,
                limit
            ],
            |r| {
                let kind: String = r.get(5)?;
                Ok(SearchHit {
                    document_id: r.get(0)?,
                    version_id: r.get(1)?,
                    title: r.get(2)?,
                    folder_id: r.get(3)?,
                    unit: r.get(4)?,
                    unit_kind: UnitKind::for_kind(&kind),
                    snippet: r.get(6)?,
                    start_ms: r.get::<_, Option<i64>>(7)?.map(|v| v.max(0) as u64),
                })
            },
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_is_tokenized_and_quoted() {
        assert_eq!(fts_query(""), None);
        assert_eq!(fts_query("  ,;!  "), None);
        assert_eq!(fts_query("città"), Some("\"città\"*".into()));
        assert_eq!(
            fts_query("Rossi AND \"NEAR(a b)\" -x OR y*"),
            Some("\"Rossi\" \"AND\" \"NEAR\" \"a\" \"b\" \"x\" \"OR\" \"y\"*".into())
        );
        assert_eq!(fts_query("l'analisi"), Some("\"l\" \"analisi\"*".into()));
    }

    #[test]
    fn query_token_count_is_bounded() {
        let many = "a ".repeat(100);
        let q = fts_query(&many).unwrap();
        assert_eq!(q.matches('"').count(), MAX_QUERY_TOKENS * 2);
    }
}
