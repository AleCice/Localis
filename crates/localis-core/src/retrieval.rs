//! Deterministic question analysis (inventory, document references) and passage retrieval
//! (lexical FTS5, semantic cosine, RRF fusion, evidence selection). No model is involved
//! in deciding what to search.

use std::collections::{HashMap, HashSet};

use rusqlite::params;

use crate::error::Result;
use crate::formats::DocumentKind;
use crate::search::UnitKind;
use crate::store::Store;

/// Max raw results kept (lexical and semantic lists, and the fused list).
pub const RAW_MAX: usize = 30;
/// Max passages given to the model.
pub const EVIDENCE_MAX: usize = 8;
/// Character budget of the passages given to the model.
pub const EVIDENCE_BUDGET_CHARS: usize = 6000;
/// RRF constant.
pub const RRF_K: f64 = 60.0;
/// Semantic results below this cosine similarity are ignored.
pub const MIN_COSINE: f32 = 0.2;
/// Semantic results more than this below the best match are ignored: absolute cosine values
/// are not comparable across embedding models, the gap to the best match is more stable.
pub const MAX_COSINE_GAP: f32 = 0.15;
const MAX_QUERY_TERMS: usize = 32;
const MAX_TERM_CHARS: usize = 100;
/// Prefix matching only for terms of at least this many characters.
const PREFIX_MIN_CHARS: usize = 4;

/// Italian stopwords (accents removed, lowercase), plus words that refer to the documents
/// themselves or to the request ("documento", "dimmi"), which carry no content.
const STOPWORDS: &[&str] = &[
    // articles, prepositions (simple and articulated)
    "il",
    "lo",
    "la",
    "i",
    "gli",
    "le",
    "l",
    "un",
    "uno",
    "una",
    "un",
    "di",
    "a",
    "da",
    "in",
    "con",
    "su",
    "per",
    "tra",
    "fra",
    "del",
    "dello",
    "della",
    "dei",
    "degli",
    "delle",
    "dell",
    "al",
    "allo",
    "alla",
    "ai",
    "agli",
    "alle",
    "all",
    "dal",
    "dallo",
    "dalla",
    "dai",
    "dagli",
    "dalle",
    "dall",
    "nel",
    "nello",
    "nella",
    "nei",
    "negli",
    "nelle",
    "nell",
    "sul",
    "sullo",
    "sulla",
    "sui",
    "sugli",
    "sulle",
    "sull",
    "col",
    "coi",
    "d",
    // conjunctions, adverbs
    "e",
    "ed",
    "o",
    "od",
    "ma",
    "anche",
    "pure",
    "se",
    "che",
    "non",
    "ne",
    "ci",
    "vi",
    "si",
    "come",
    "quando",
    "dove",
    "perche",
    "poi",
    "piu",
    "meno",
    "molto",
    "poco",
    "tanto",
    "gia",
    "ancora",
    "solo",
    "sempre",
    "mai",
    "cosi",
    "quindi",
    "allora",
    "oppure",
    "pero",
    "invece",
    "mentre",
    "dunque",
    "circa",
    "tutto",
    "tutti",
    "tutta",
    "tutte",
    "ogni",
    "qualche",
    // pronouns, determiners
    "io",
    "tu",
    "lui",
    "lei",
    "noi",
    "voi",
    "loro",
    "me",
    "te",
    "mi",
    "ti",
    "lo",
    "gli",
    "esso",
    "essa",
    "essi",
    "esse",
    "mio",
    "mia",
    "miei",
    "mie",
    "tuo",
    "tua",
    "tuoi",
    "tue",
    "suo",
    "sua",
    "suoi",
    "sue",
    "nostro",
    "nostra",
    "vostro",
    "vostra",
    "questo",
    "questa",
    "questi",
    "queste",
    "quest",
    "quello",
    "quella",
    "quelli",
    "quelle",
    "quel",
    "quei",
    "quegli",
    "quell",
    "stesso",
    "stessa",
    "altro",
    "altra",
    "altri",
    "altre",
    "cui",
    "chi",
    "cosa",
    "cos",
    "quale",
    "quali",
    "quanto",
    "quanta",
    "quanti",
    "quante",
    "qual",
    // common verb forms
    "e",
    "sono",
    "sei",
    "siamo",
    "siete",
    "era",
    "erano",
    "essere",
    "stato",
    "stata",
    "stati",
    "ho",
    "hai",
    "ha",
    "abbiamo",
    "avete",
    "hanno",
    "avere",
    "aveva",
    "avevano",
    "fa",
    "fare",
    "fanno",
    "puo",
    "possono",
    "posso",
    "deve",
    "devono",
    "c",
    "viene",
    "vengono",
    "sia",
    "siano",
    "fosse",
    "sarebbe",
    "essendo",
    "avendo",
    "dice",
    "dicono",
    // request and meta words
    "dimmi",
    "dammi",
    "spiega",
    "spiegami",
    "parlami",
    "descrivi",
    "elenca",
    "riassumi",
    "riassunto",
    "sintesi",
    "cerca",
    "trova",
    "mostra",
    "mostrami",
    "secondo",
    "riguardo",
    "documento",
    "documenti",
    "file",
    "pdf",
    "testo",
    "fonte",
    "fonti",
    "parla",
    "parlano",
    "please",
    "grazie",
    "ciao",
    "puoi",
    "potresti",
    "vorrei",
    "sapere",
];

/// Lowercases, removes accents and turns punctuation into spaces.
pub fn normalize_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        if ('\u{300}'..='\u{36f}').contains(&c) {
            continue; // combining accents
        }
        for lower in c.to_lowercase() {
            let base = fold_accent(lower);
            if base.is_alphanumeric() {
                out.push(base);
            } else {
                out.push(' ');
            }
        }
    }
    out
}

fn fold_accent(c: char) -> char {
    match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
        'è' | 'é' | 'ê' | 'ë' => 'e',
        'ì' | 'í' | 'î' | 'ï' => 'i',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' => 'o',
        'ù' | 'ú' | 'û' | 'ü' => 'u',
        'ç' => 'c',
        'ñ' => 'n',
        'ý' | 'ÿ' => 'y',
        other => other,
    }
}

/// Words of a normalized text.
pub fn words(input: &str) -> Vec<String> {
    normalize_text(input)
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

fn is_stopword(word: &str) -> bool {
    STOPWORDS.contains(&word)
}

/// Builds the lexical FTS5 query for a question: significant terms (stopwords and
/// one-letter words removed, duplicates dropped), each quoted, joined with OR; terms of at
/// least 4 characters match as prefixes. `None` when nothing significant remains.
pub fn lexical_query(question: &str) -> Option<String> {
    let is_word_char = |c: char| c.is_alphanumeric() || ('\u{300}'..='\u{36f}').contains(&c);
    let mut seen = HashSet::new();
    let mut parts = Vec::new();
    for raw in question.split(|c: char| !is_word_char(c)) {
        if raw.is_empty() {
            continue;
        }
        let token: String = raw.chars().take(MAX_TERM_CHARS).collect();
        let key = normalize_text(&token).trim().to_owned();
        if key.chars().count() < 2 || is_stopword(&key) || !seen.insert(key) {
            continue;
        }
        let mut quoted = format!("\"{}\"", token.replace('"', "\"\""));
        if token.chars().count() >= PREFIX_MIN_CHARS {
            quoted.push('*');
        }
        parts.push(quoted);
        if parts.len() == MAX_QUERY_TERMS {
            break;
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" OR "))
    }
}

// ------------------------------------------------------------------ intent

/// True when the question asks which documents the project contains (answered by Localis
/// from the library, without the model).
pub fn is_inventory_question(question: &str) -> bool {
    let w = words(question);
    let has = |list: &[&str]| w.iter().any(|x| list.contains(&x.as_str()));
    let nouns = [
        "documenti",
        "file",
        "files",
        "pdf",
        "fonti",
        "materiali",
        "allegati",
        "testi",
        "documento",
    ];
    // Questions about content ("quali documenti parlano di…") are not inventories.
    let content_markers = [
        "parla",
        "parlano",
        "dice",
        "dicono",
        "contiene",
        "contengono",
        "tratta",
        "trattano",
        "riguarda",
        "riguardano",
        "spiega",
        "spiegano",
        "cita",
        "citano",
        "menziona",
        "menzionano",
        "descrive",
        "descrivono",
        "argomento",
        "argomenti",
        "dove",
        "perche",
        "sostiene",
        "sostengono",
        "afferma",
        "affermano",
        "cosa",
        "parlato",
    ];
    let list_verbs = [
        "elenca",
        "elencami",
        "elencare",
        "elenco",
        "lista",
        "mostra",
        "mostrami",
        "mostrare",
        "visualizza",
        "dimmi",
        "indica",
        "indicami",
    ];
    let upload_verbs = [
        "caricato",
        "caricati",
        "caricate",
        "caricata",
        "importato",
        "importati",
        "importate",
        "aggiunto",
        "aggiunti",
        "inserito",
        "inseriti",
        "salvato",
        "salvati",
    ];
    let presence = [
        "ci",
        "sono",
        "presenti",
        "disponibili",
        "progetto",
        "libreria",
        "ho",
        "abbiamo",
        "hai",
        "contiene",
    ];
    let pos = |word: &str| w.iter().position(|x| x == word);

    // «cosa ho caricato?», «che cosa abbiamo importato»
    if has(&upload_verbs)
        && (pos("cosa").is_some() || pos("che").is_some())
        && (has(&["ho", "abbiamo", "hai", "ha"]))
        && !has(&[
            "dice",
            "dicono",
            "parla",
            "parlano",
            "contiene",
            "contengono",
            "riguarda",
        ])
    {
        return true;
    }
    if !has(&nouns) {
        return false;
    }
    let content = w
        .iter()
        .any(|x| content_markers.contains(&x.as_str()) && x != "cosa");
    if content {
        return false;
    }
    // «quali/che/quanti documenti …», «elenca i file», «lista dei pdf»
    let noun_idx = w.iter().position(|x| nouns.contains(&x.as_str()));
    let asks_which = w.iter().enumerate().any(|(i, x)| {
        matches!(x.as_str(), "quali" | "che" | "quanti" | "quante")
            && noun_idx.is_some_and(|n| n > i && n - i <= 4)
    });
    let lists = has(&list_verbs);
    if asks_which && (has(&upload_verbs) || has(&presence) || w.len() <= 4) {
        return true;
    }
    if lists && (has(&upload_verbs) || has(&presence) || has(&["tutti", "tutte", "miei", "i"])) {
        // «dimmi il file» is not a list request: require a plural noun or "tutti".
        return w.iter().any(|x| {
            [
                "documenti",
                "file",
                "files",
                "pdf",
                "fonti",
                "materiali",
                "allegati",
                "testi",
            ]
            .contains(&x.as_str())
        });
    }
    false
}

/// True when the question refers to "this document" without naming it.
pub fn has_deictic_reference(question: &str) -> bool {
    let w = words(question);
    let determiners = [
        "questo", "quel", "quello", "quest", "il", "lo", "nel", "nello", "del", "dello", "dal",
        "al", "sul", "stesso", "tale", "suddetto",
    ];
    let nouns = [
        "documento",
        "file",
        "pdf",
        "testo",
        "articolo",
        "libro",
        "paper",
        "saggio",
        "fonte",
    ];
    let fem_det = [
        "questa", "quella", "la", "nella", "della", "sulla", "stessa",
    ];
    let fem_nouns = ["fonte", "dispensa", "relazione", "tesi", "presentazione"];
    w.windows(2).any(|pair| {
        (determiners.contains(&pair[0].as_str()) && nouns.contains(&pair[1].as_str()))
            || (fem_det.contains(&pair[0].as_str())
                && fem_nouns.contains(&pair[1].as_str())
                && pair[0].starts_with("quest"))
    }) || w.iter().any(|x| x == "quest" || x == "ultimo")
        && w.iter().any(|x| nouns.contains(&x.as_str()))
}

// ------------------------------------------------------------- title match

/// A project document as seen by the title matcher.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocRef {
    pub id: String,
    pub title: String,
}

/// Result of matching document titles against a question.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TitleMatch {
    None,
    /// Documents named unambiguously (one or more, each by its own words).
    Documents(Vec<String>),
    /// The same words name several documents.
    Ambiguous(Vec<String>),
}

#[derive(Debug, Clone)]
struct Hit {
    doc: usize,
    tier: u8,
    positions: Vec<usize>,
}

fn find_sequence(hay: &[String], needle: &[String]) -> Option<Vec<usize>> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    (0..=hay.len() - needle.len())
        .find(|&i| hay[i..i + needle.len()] == *needle)
        .map(|i| (i..i + needle.len()).collect())
}

fn strip_extension(title: &str) -> &str {
    match title.rfind('.') {
        Some(i)
            if i > 0
                && title.len() - i <= 6
                && title[i + 1..].chars().all(char::is_alphanumeric) =>
        {
            &title[..i]
        }
        _ => title,
    }
}

/// Matches document titles in the question (normalized: lowercase, no accents,
/// punctuation as spaces):
/// 1. whole title with extension as a word sequence;
/// 2. whole title without extension (at least 4 letters, not only stopwords);
/// 3. all significant words of the title (≥ 2 words of ≥ 3 letters, not stopwords).
///
/// Only the best tier counts; a match contained in a longer one is dropped. When the same
/// words match several documents the result is ambiguous.
pub fn match_titles(question: &str, docs: &[DocRef]) -> TitleMatch {
    let q = words(question);
    let mut hits: Vec<Hit> = Vec::new();
    for (i, doc) in docs.iter().enumerate() {
        let full = words(&doc.title);
        if full.len() >= 2 || full.first().is_some_and(|w| w.len() >= 4) {
            if let Some(positions) = find_sequence(&q, &full) {
                // Whole title including the extension, when it has one.
                let tier = if strip_extension(&doc.title) != doc.title {
                    1
                } else {
                    2
                };
                hits.push(Hit {
                    doc: i,
                    tier,
                    positions,
                });
                continue;
            }
        }
        let stem = words(strip_extension(&doc.title));
        let stem_letters: usize = stem.iter().map(|w| w.chars().count()).sum();
        if stem_letters >= 4 && stem.iter().any(|w| !is_stopword(w)) {
            if let Some(positions) = find_sequence(&q, &stem) {
                hits.push(Hit {
                    doc: i,
                    tier: 2,
                    positions,
                });
                continue;
            }
        }
        let significant: Vec<&String> = stem
            .iter()
            .filter(|w| w.chars().count() >= 3 && !is_stopword(w))
            .collect();
        if significant.len() >= 2 {
            let mut positions = Vec::new();
            let all = significant
                .iter()
                .all(|s| match q.iter().position(|x| x == *s) {
                    Some(p) => {
                        positions.push(p);
                        true
                    }
                    None => false,
                });
            if all {
                positions.sort_unstable();
                positions.dedup();
                hits.push(Hit {
                    doc: i,
                    tier: 3,
                    positions,
                });
            }
        }
    }
    let Some(best) = hits.iter().map(|h| h.tier).min() else {
        return TitleMatch::None;
    };
    hits.retain(|h| h.tier == best);
    // Drop matches strictly contained in a longer one («relazione» inside «relazione finale»).
    let contained = |a: &Hit, b: &Hit| {
        b.positions.len() > a.positions.len() && a.positions.iter().all(|p| b.positions.contains(p))
    };
    let kept: Vec<Hit> = hits
        .iter()
        .filter(|a| !hits.iter().any(|b| contained(a, b)))
        .cloned()
        .collect();
    // Group by the words matched: the same words for several documents = ambiguity.
    let mut groups: Vec<(Vec<usize>, Vec<usize>)> = Vec::new();
    for h in &kept {
        match groups
            .iter_mut()
            .find(|(pos, _)| pos.iter().any(|p| h.positions.contains(p)))
        {
            Some((_, docs_in)) => docs_in.push(h.doc),
            None => groups.push((h.positions.clone(), vec![h.doc])),
        }
    }
    let ambiguous: Vec<String> = groups
        .iter()
        .filter(|(_, d)| d.len() > 1)
        .flat_map(|(_, d)| d.iter().map(|&i| docs[i].id.clone()))
        .collect();
    if !ambiguous.is_empty() {
        return TitleMatch::Ambiguous(ambiguous);
    }
    TitleMatch::Documents(groups.iter().map(|(_, d)| docs[d[0]].id.clone()).collect())
}

// ------------------------------------------------------------------ search

/// A passage found by retrieval.
#[derive(Debug, Clone, PartialEq)]
pub struct Passage {
    pub chunk_id: i64,
    pub document_id: String,
    pub version_id: String,
    pub title: String,
    pub unit: u32,
    pub unit_kind: UnitKind,
    pub char_start: usize,
    pub char_end: usize,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    Lexical,
    Semantic,
    Both,
    /// Not found by a search: the opening passages of a selected document, used when the
    /// question names a document but has no searchable terms (e.g. «riassumi questo documento»).
    Position,
}

impl Via {
    pub fn as_str(self) -> &'static str {
        match self {
            Via::Lexical => "lexical",
            Via::Semantic => "semantic",
            Via::Both => "both",
            Via::Position => "position",
        }
    }

    pub(crate) fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "lexical" => Via::Lexical,
            "semantic" => Via::Semantic,
            "both" => Via::Both,
            "position" => Via::Position,
            _ => return None,
        })
    }
}

/// A fused result: passage, how it was found and its RRF score.
#[derive(Debug, Clone, PartialEq)]
pub struct Ranked {
    pub passage: Passage,
    pub via: Via,
    pub score: f64,
}

const PASSAGE_COLUMNS: &str = "c.id, d.id, v.id, d.title, c.unit, v.kind, c.char_start,
    c.char_end, c.text";

fn row_to_passage(r: &rusqlite::Row<'_>) -> rusqlite::Result<Passage> {
    let kind: String = r.get(5)?;
    Ok(Passage {
        chunk_id: r.get(0)?,
        document_id: r.get(1)?,
        version_id: r.get(2)?,
        title: r.get(3)?,
        unit: r.get(4)?,
        unit_kind: if DocumentKind::parse(&kind) == Some(DocumentKind::Pdf) {
            UnitKind::Page
        } else {
            UnitKind::Block
        },
        char_start: r.get::<_, i64>(6)?.max(0) as usize,
        char_end: r.get::<_, i64>(7)?.max(0) as usize,
        text: r.get(8)?,
    })
}

/// SQL fragment limiting `d` (documents) / `v` (versions) to the project's current versions,
/// optionally to the documents in `?docs` (a JSON array, empty = whole project).
const SCOPE_SQL: &str = "d.project_id = ?2
    AND v.version_no = (SELECT MAX(m.version_no) FROM document_versions m
                        WHERE m.document_id = d.id)
    AND (json_array_length(?3) = 0 OR d.id IN (SELECT value FROM json_each(?3)))";

fn docs_json(document_ids: &[String]) -> String {
    serde_json::Value::from(document_ids.to_vec()).to_string()
}

impl Store {
    /// Lexical search over passages (bm25), best first, at most [`RAW_MAX`].
    pub fn search_passages_lexical(
        &self,
        project_id: &str,
        document_ids: &[String],
        fts_query: &str,
    ) -> Result<Vec<Passage>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {PASSAGE_COLUMNS}
             FROM chunks_fts
             JOIN chunks c ON c.id = chunks_fts.rowid
             JOIN document_versions v ON v.id = c.version_id
             JOIN documents d ON d.id = v.document_id
             WHERE chunks_fts MATCH ?1 AND {SCOPE_SQL}
             ORDER BY bm25(chunks_fts), d.title, c.unit, c.ordinal
             LIMIT ?4"
        ))?;
        let rows = stmt.query_map(
            params![
                fts_query,
                project_id,
                docs_json(document_ids),
                RAW_MAX as i64
            ],
            row_to_passage,
        )?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Opening passages (in reading order) of the documents in `document_ids`, at most
    /// [`RAW_MAX`] overall. Used only as a declared fallback when a document-scoped question
    /// has no searchable terms.
    pub fn leading_passages(
        &self,
        project_id: &str,
        document_ids: &[String],
    ) -> Result<Vec<Passage>> {
        if document_ids.is_empty() {
            return Ok(Vec::new());
        }
        // Round-robin across the selected documents (first passage of each, then the second…),
        // so selecting several documents does not cover only the first one.
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {PASSAGE_COLUMNS}
             FROM chunks c
             JOIN document_versions v ON v.id = c.version_id
             JOIN documents d ON d.id = v.document_id
             WHERE {SCOPE_SQL}
             ORDER BY ROW_NUMBER() OVER (PARTITION BY d.id ORDER BY c.unit, c.ordinal),
                      d.title, d.id
             LIMIT ?4"
        ))?;
        let rows = stmt.query_map(
            params!["", project_id, docs_json(document_ids), RAW_MAX as i64],
            row_to_passage,
        )?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Number of passages in scope that have an embedding for `model`.
    pub fn embedded_passages_in_scope(
        &self,
        project_id: &str,
        document_ids: &[String],
        model: &str,
    ) -> Result<u64> {
        let n: i64 = self.conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM chunk_embeddings e
                 JOIN chunks c ON c.id = e.chunk_id
                 JOIN document_versions v ON v.id = c.version_id
                 JOIN documents d ON d.id = v.document_id
                 WHERE e.model = ?1 AND {SCOPE_SQL}"
            ),
            params![model, project_id, docs_json(document_ids)],
            |r| r.get(0),
        )?;
        Ok(n.max(0) as u64)
    }

    /// Semantic search: cosine similarity between `query` (L2-normalized) and the passages
    /// in scope embedded with `model`; best first, at most [`RAW_MAX`], above [`MIN_COSINE`].
    pub fn search_passages_semantic(
        &self,
        project_id: &str,
        document_ids: &[String],
        model: &str,
        query: &[f32],
    ) -> Result<Vec<(Passage, f32)>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {PASSAGE_COLUMNS}, e.vector
             FROM chunk_embeddings e
             JOIN chunks c ON c.id = e.chunk_id
             JOIN document_versions v ON v.id = c.version_id
             JOIN documents d ON d.id = v.document_id
             WHERE e.model = ?1 AND {SCOPE_SQL}"
        ))?;
        // Bind ?1 = model, ?2 = project, ?3 = docs (SCOPE_SQL uses ?2/?3).
        let mut rows = stmt.query(params![model, project_id, docs_json(document_ids)])?;
        let mut scored = Vec::new();
        while let Some(row) = rows.next()? {
            let blob: Vec<u8> = row.get(9)?;
            let vector = decode_vector(&blob);
            if vector.len() != query.len() {
                continue;
            }
            let score: f32 = vector.iter().zip(query).map(|(a, b)| a * b).sum();
            if score >= MIN_COSINE {
                scored.push((row_to_passage(row)?, score));
            }
        }
        scored.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.0.chunk_id.cmp(&b.0.chunk_id))
        });
        if let Some(best) = scored.first().map(|(_, s)| *s) {
            scored.retain(|(_, s)| *s >= best - MAX_COSINE_GAP);
        }
        scored.truncate(RAW_MAX);
        Ok(scored)
    }
}

pub(crate) fn encode_vector(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

pub(crate) fn decode_vector(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

/// Reciprocal rank fusion (k = 60) of the lexical and semantic lists; at most [`RAW_MAX`].
/// Ties keep the lexical order first.
pub fn fuse(lexical: Vec<Passage>, semantic: Vec<Passage>) -> Vec<Ranked> {
    let mut by_chunk: HashMap<i64, usize> = HashMap::new();
    let mut out: Vec<(Ranked, usize)> = Vec::new();
    for (rank, p) in lexical.into_iter().enumerate() {
        by_chunk.insert(p.chunk_id, out.len());
        out.push((
            Ranked {
                passage: p,
                via: Via::Lexical,
                score: 1.0 / (RRF_K + rank as f64 + 1.0),
            },
            rank,
        ));
    }
    let offset = out.len();
    for (rank, p) in semantic.into_iter().enumerate() {
        let add = 1.0 / (RRF_K + rank as f64 + 1.0);
        match by_chunk.get(&p.chunk_id) {
            Some(&i) => {
                out[i].0.score += add;
                out[i].0.via = Via::Both;
            }
            None => {
                by_chunk.insert(p.chunk_id, out.len());
                out.push((
                    Ranked {
                        passage: p,
                        via: Via::Semantic,
                        score: add,
                    },
                    offset + rank,
                ));
            }
        }
    }
    out.sort_by(|a, b| {
        b.0.score
            .partial_cmp(&a.0.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.1.cmp(&b.1))
    });
    out.truncate(RAW_MAX);
    out.into_iter().map(|(r, _)| r).collect()
}

/// Picks the passages for the prompt: in fused order, at most [`EVIDENCE_MAX`] within
/// [`EVIDENCE_BUDGET_CHARS`], skipping duplicates (same version and unit with overlapping
/// text, or identical text). Different pages of the same document are kept. Returns
/// indexes into `ranked`; the first passage is always taken.
pub fn select_evidence(ranked: &[Ranked]) -> Vec<usize> {
    let mut chosen: Vec<usize> = Vec::new();
    let mut used = 0usize;
    let mut texts: HashSet<String> = HashSet::new();
    for (i, r) in ranked.iter().enumerate() {
        if chosen.len() == EVIDENCE_MAX {
            break;
        }
        let p = &r.passage;
        let overlaps = chosen.iter().any(|&j| {
            let q = &ranked[j].passage;
            q.version_id == p.version_id
                && q.unit == p.unit
                && p.char_start < q.char_end
                && q.char_start < p.char_end
        });
        let key = normalize_text(&p.text)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if overlaps || texts.contains(&key) {
            continue;
        }
        let len = p.text.chars().count();
        if !chosen.is_empty() && used + len > EVIDENCE_BUDGET_CHARS {
            continue;
        }
        used += len;
        texts.insert(key);
        chosen.push(i);
    }
    chosen
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization() {
        assert_eq!(
            normalize_text("Perché l'Analisi È-bella!"),
            "perche l analisi e bella "
        );
        assert_eq!(words("  Città  Ünïcode "), ["citta", "unicode"]);
        // Decomposed accents (e + U+0301) fold too.
        assert_eq!(words("perche\u{301}"), ["perche"]);
    }

    #[test]
    fn lexical_query_drops_stopwords_and_uses_or() {
        assert_eq!(
            lexical_query("Che cos'è la funzione di Lagrange?").as_deref(),
            Some("\"funzione\"* OR \"Lagrange\"*")
        );
        assert_eq!(
            lexical_query("Quali sono le età del ferro e del bronzo").as_deref(),
            Some("\"età\" OR \"ferro\"* OR \"bronzo\"*")
        );
        assert_eq!(lexical_query("che cosa è questo?"), None);
        assert_eq!(lexical_query("   "), None);
        // Duplicates (also by accent/case) are dropped.
        assert_eq!(
            lexical_query("Città città CITTA").as_deref(),
            Some("\"Città\"*")
        );
    }

    #[test]
    fn lexical_query_never_passes_fts_syntax() {
        let q = lexical_query(r#"NEAR(a b) "x" OR y* -z AND col:val ^start"#).unwrap();
        // ("col" is an Italian stopword: «con il».)
        assert_eq!(q, "\"NEAR\"* OR \"OR\" OR \"AND\" OR \"val\" OR \"start\"*");
        let many = (0..100)
            .map(|i| format!("parola{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(
            lexical_query(&many).unwrap().matches(" OR ").count(),
            MAX_QUERY_TERMS - 1
        );
    }

    #[test]
    fn inventory_phrasings() {
        for q in [
            "Quali documenti ho caricato?",
            "quali file ci sono?",
            "Che file ci sono nel progetto?",
            "Elenca i documenti",
            "elencami tutti i file",
            "Mostrami i PDF caricati",
            "Cosa ho caricato?",
            "Che cosa abbiamo importato finora?",
            "Quanti documenti ci sono?",
            "Lista dei documenti del progetto",
            "quali sono i miei documenti",
            "Quali fonti hai a disposizione?",
        ] {
            assert!(is_inventory_question(q), "{q}");
        }
        for q in [
            "Quali documenti parlano di Napoleone?",
            "Che cosa dice il documento sulla fotosintesi?",
            "Riassumi il file",
            "Cosa dice il file caricato ieri?",
            "Qual è la tesi principale?",
            "Spiegami il teorema di Rolle",
            "dimmi il file che parla di storia",
            "In quale documento si cita Dante?",
        ] {
            assert!(!is_inventory_question(q), "{q}");
        }
    }

    #[test]
    fn deictic_phrasings() {
        for q in [
            "Riassumi questo documento",
            "Cosa dice il file?",
            "Di cosa parla quel pdf?",
            "Nel documento, qual è la conclusione?",
            "Quali sono le tesi di quest'articolo?",
            "Spiegami meglio questa dispensa",
        ] {
            assert!(has_deictic_reference(q), "{q}");
        }
        for q in [
            "Cos'è la fotosintesi?",
            "Quali documenti ho caricato?",
            "Parlami di Dante",
        ] {
            assert!(!has_deictic_reference(q), "{q}");
        }
    }

    fn docs(titles: &[&str]) -> Vec<DocRef> {
        titles
            .iter()
            .enumerate()
            .map(|(i, t)| DocRef {
                id: format!("d{i}"),
                title: (*t).into(),
            })
            .collect()
    }

    #[test]
    fn title_matching_tiers() {
        let d = docs(&[
            "Relazione finale.pdf",
            "Relazione.pdf",
            "Appunti di storia medievale.docx",
            "a.txt",
            "Note.md",
        ]);
        assert_eq!(
            match_titles("Cosa conclude Relazione finale.pdf?", &d),
            TitleMatch::Documents(vec!["d0".into()])
        );
        // Longer match wins over the contained one.
        assert_eq!(
            match_titles("riassumi la relazione finale", &d),
            TitleMatch::Documents(vec!["d0".into()])
        );
        assert_eq!(
            match_titles("Cosa dice relazione.pdf", &d),
            TitleMatch::Documents(vec!["d1".into()])
        );
        // All significant words, in any order, accents ignored.
        assert_eq!(
            match_titles(
                "negli appunti di storia (medievale) cosa c'è sui Comuni?",
                &d
            ),
            TitleMatch::Documents(vec!["d2".into()])
        );
        assert_eq!(
            match_titles("Nella storia medievale, cosa sono i comuni?", &d),
            TitleMatch::None,
            "only 2 of 3 significant words: «appunti» missing"
        );
        // Very short titles never match by stem.
        assert_eq!(match_titles("a cosa serve?", &d), TitleMatch::None);
        assert_eq!(
            match_titles("apri a.txt", &d),
            TitleMatch::Documents(vec!["d3".into()])
        );
        assert_eq!(
            match_titles("confronta Relazione.pdf e Note.md", &d),
            TitleMatch::Documents(vec!["d1".into(), "d4".into()])
        );
    }

    #[test]
    fn identical_titles_are_ambiguous() {
        let d = docs(&["Capitolo 1.pdf", "Capitolo 1.pdf", "Altro.txt"]);
        assert_eq!(
            match_titles("Riassumi Capitolo 1.pdf", &d),
            TitleMatch::Ambiguous(vec!["d0".into(), "d1".into()])
        );
        let d = docs(&["Tesi.pdf", "Tesi.docx"]);
        assert_eq!(
            match_titles("di cosa parla la tesi?", &d),
            TitleMatch::Ambiguous(vec!["d0".into(), "d1".into()])
        );
    }

    fn passage(chunk_id: i64, version: &str, unit: u32, start: usize, text: &str) -> Passage {
        Passage {
            chunk_id,
            document_id: format!("doc-{version}"),
            version_id: version.into(),
            title: "t".into(),
            unit,
            unit_kind: UnitKind::Page,
            char_start: start,
            char_end: start + text.chars().count(),
            text: text.into(),
        }
    }

    #[test]
    fn rrf_fusion_marks_via_and_orders() {
        let a = passage(1, "v", 1, 0, "a");
        let b = passage(2, "v", 2, 0, "b");
        let c = passage(3, "v", 3, 0, "c");
        let fused = fuse(vec![a.clone(), b.clone()], vec![b.clone(), c.clone()]);
        let ids: Vec<i64> = fused.iter().map(|r| r.passage.chunk_id).collect();
        assert_eq!(ids, [2, 1, 3]);
        assert_eq!(fused[0].via, Via::Both);
        assert_eq!(fused[1].via, Via::Lexical);
        assert_eq!(fused[2].via, Via::Semantic);
        assert!((fused[0].score - (1.0 / 62.0 + 1.0 / 61.0)).abs() < 1e-12);
        // Lexical only keeps the order.
        let fused = fuse(vec![c.clone(), a.clone()], vec![]);
        assert_eq!(fused[0].passage.chunk_id, 3);
    }

    #[test]
    fn evidence_dedup_keeps_distinct_pages_and_respects_budget() {
        let same = "Il teorema di Rolle afferma che…";
        let ranked: Vec<Ranked> = vec![
            passage(1, "v1", 1, 0, same),
            passage(2, "v1", 1, 0, same), // same unit, overlapping → dropped
            passage(3, "v1", 2, 0, same), // identical text on another page → dropped
            passage(4, "v1", 2, 100, "pagina due"), // other page → kept
            passage(5, "v2", 1, 0, "  il TEOREMA di rolle afferma che… "), // same text normalized
        ]
        .into_iter()
        .map(|p| Ranked {
            passage: p,
            via: Via::Lexical,
            score: 0.0,
        })
        .collect();
        assert_eq!(select_evidence(&ranked), [0, 3]);

        let long = "x".repeat(1200);
        let ranked: Vec<Ranked> = (0..10)
            .map(|i| Ranked {
                passage: passage(i, "v", i as u32, 0, &format!("{i}{long}")),
                via: Via::Lexical,
                score: 0.0,
            })
            .collect();
        let chosen = select_evidence(&ranked);
        assert_eq!(chosen, [0, 1, 2, 3]); // 4 × 1201 ≤ 6000 < 5 × 1201
        let small: Vec<Ranked> = (0..12)
            .map(|i| Ranked {
                passage: passage(i, "v", i as u32, 0, &format!("passaggio {i}")),
                via: Via::Lexical,
                score: 0.0,
            })
            .collect();
        assert_eq!(select_evidence(&small).len(), EVIDENCE_MAX);
    }

    #[test]
    fn vectors_round_trip() {
        let v = vec![0.5f32, -0.25, 1.0];
        assert_eq!(decode_vector(&encode_vector(&v)), v);
    }
}
