//! v0.5 manual links between an interval of a recording and a PDF page or an image,
//! optionally a region of it. A region is a non-destructive reference (normalised 0..1
//! coordinates): originals are never modified. Deleting the media or the target deletes its
//! links (foreign keys with CASCADE).

use rusqlite::{params, OptionalExtension, Row};

use crate::error::{CoreError, Result};
use crate::formats::DocumentKind;
use crate::store::{now, Store};

/// Max characters of a link note.
pub const LINK_NOTE_MAX: usize = 2000;
/// Tolerance for regions that touch the right/bottom edge after float rounding.
const EDGE_EPSILON: f64 = 1e-6;

const LINK_NOT_FOUND: &str = "Il collegamento non esiste più.";
const MEDIA_REQUIRED: &str = "Si possono collegare solo registrazioni audio o video.";
const TARGET_KIND: &str = "La destinazione deve essere un PDF o un'immagine.";
const OTHER_PROJECT: &str = "La destinazione appartiene a un altro progetto.";
const START_INVALID: &str = "L'inizio deve essere un istante valido della registrazione.";
const END_INVALID: &str = "La fine deve essere dopo l'inizio e non oltre la durata della registrazione.";
const PAGE_REQUIRED: &str = "Indica la pagina del PDF.";
const PAGE_INVALID: &str = "La pagina non esiste nel PDF.";
const PAGE_NOT_FOR_IMAGES: &str = "Le immagini non hanno pagine.";
const REGION_INVALID: &str = "La regione deve stare dentro la pagina o l'immagine.";
const NOTE_TOO_LONG: &str = "La nota può avere al massimo 2000 caratteri.";
const NOTE_INVALID: &str = "La nota contiene caratteri non validi.";

/// Region normalised to the page/image size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Unvalidated input (`MediaLinkInput` in `src/api/types.ts`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MediaLinkInput {
    pub media_version_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub target_version_id: String,
    pub target_page: Option<i64>,
    pub region: Option<Region>,
    pub note: Option<String>,
}

/// A stored link (`MediaLink` in `src/api/types.ts`).
#[derive(Debug, Clone, PartialEq)]
pub struct MediaLink {
    pub id: String,
    pub project_id: String,
    pub media_document_id: String,
    pub media_version_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub target_document_id: String,
    pub target_version_id: String,
    pub target_page: Option<u32>,
    pub region: Option<Region>,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Titles when the link was created or last updated.
    pub media_title: String,
    pub target_title: String,
    /// Both versions still exist.
    pub available: bool,
}

const LINK_COLUMNS: &str = "l.id, l.project_id, l.media_document_id, l.media_version_id,
    l.start_ms, l.end_ms, l.target_document_id, l.target_version_id, l.target_page,
    l.region_x, l.region_y, l.region_w, l.region_h, l.note, l.created_at, l.updated_at,
    l.media_title, l.target_title,
    EXISTS (SELECT 1 FROM document_versions v WHERE v.id = l.media_version_id)
      AND EXISTS (SELECT 1 FROM document_versions v WHERE v.id = l.target_version_id)";

fn row_to_link(r: &Row<'_>) -> rusqlite::Result<MediaLink> {
    let region = match (
        r.get::<_, Option<f64>>(9)?,
        r.get::<_, Option<f64>>(10)?,
        r.get::<_, Option<f64>>(11)?,
        r.get::<_, Option<f64>>(12)?,
    ) {
        (Some(x), Some(y), Some(w), Some(h)) => Some(Region { x, y, w, h }),
        _ => None,
    };
    Ok(MediaLink {
        id: r.get(0)?,
        project_id: r.get(1)?,
        media_document_id: r.get(2)?,
        media_version_id: r.get(3)?,
        start_ms: r.get::<_, i64>(4)?.max(0) as u64,
        end_ms: r.get::<_, i64>(5)?.max(0) as u64,
        target_document_id: r.get(6)?,
        target_version_id: r.get(7)?,
        target_page: r.get(8)?,
        region,
        note: r.get(13)?,
        created_at: r.get(14)?,
        updated_at: r.get(15)?,
        media_title: r.get(16)?,
        target_title: r.get(17)?,
        available: r.get(18)?,
    })
}

/// A validated input with what it resolved to.
struct Checked {
    project_id: String,
    media_document_id: String,
    media_title: String,
    target_document_id: String,
    target_title: String,
    start_ms: i64,
    end_ms: i64,
    target_page: Option<u32>,
    region: Option<Region>,
    note: Option<String>,
}

fn validate_region(region: Option<Region>) -> Result<Option<Region>> {
    let Some(r) = region else {
        return Ok(None);
    };
    let finite = [r.x, r.y, r.w, r.h].iter().all(|v| v.is_finite());
    let inside = finite
        && r.x >= 0.0
        && r.y >= 0.0
        && r.w > 0.0
        && r.h > 0.0
        && r.x + r.w <= 1.0 + EDGE_EPSILON
        && r.y + r.h <= 1.0 + EDGE_EPSILON;
    if !inside {
        return Err(CoreError::validation("region", REGION_INVALID));
    }
    Ok(Some(r))
}

fn validate_note(note: Option<&str>) -> Result<Option<String>> {
    let Some(note) = note.map(str::trim).filter(|n| !n.is_empty()) else {
        return Ok(None);
    };
    if note.chars().count() > LINK_NOTE_MAX {
        return Err(CoreError::validation("note", NOTE_TOO_LONG));
    }
    if note
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(CoreError::validation("note", NOTE_INVALID));
    }
    Ok(Some(note.to_owned()))
}

impl Store {
    fn check_link(&self, input: &MediaLinkInput) -> Result<Checked> {
        let media = self.get_version(&input.media_version_id)?;
        if !media.kind.is_media() {
            return Err(CoreError::validation("mediaVersionId", MEDIA_REQUIRED));
        }
        let media_doc = self.get_document(&media.document_id)?;
        let target = self.get_version(&input.target_version_id)?;
        let target_doc = self.get_document(&target.document_id)?;
        if target_doc.project_id != media_doc.project_id {
            return Err(CoreError::validation("targetVersionId", OTHER_PROJECT));
        }
        if input.start_ms < 0 || media.duration_ms.is_some_and(|d| input.start_ms as u64 >= d) {
            return Err(CoreError::validation("startMs", START_INVALID));
        }
        if input.end_ms <= input.start_ms
            || media.duration_ms.is_some_and(|d| input.end_ms as u64 > d)
        {
            return Err(CoreError::validation("endMs", END_INVALID));
        }
        let target_page = match target.kind {
            DocumentKind::Pdf => {
                let page = input
                    .target_page
                    .ok_or_else(|| CoreError::validation("targetPage", PAGE_REQUIRED))?;
                // The page count is known once the text extraction ran; before that any
                // positive page is accepted.
                let valid = page >= 1
                    && u32::try_from(page).is_ok()
                    && target.page_count.is_none_or(|n| page <= i64::from(n));
                if !valid {
                    return Err(CoreError::validation("targetPage", PAGE_INVALID));
                }
                Some(page as u32)
            }
            DocumentKind::Image => {
                if input.target_page.is_some() {
                    return Err(CoreError::validation("targetPage", PAGE_NOT_FOR_IMAGES));
                }
                None
            }
            _ => return Err(CoreError::validation("targetVersionId", TARGET_KIND)),
        };
        Ok(Checked {
            project_id: media_doc.project_id.clone(),
            media_document_id: media_doc.id,
            media_title: media_doc.title,
            target_document_id: target_doc.id,
            target_title: target_doc.title,
            start_ms: input.start_ms,
            end_ms: input.end_ms,
            target_page,
            region: validate_region(input.region)?,
            note: validate_note(input.note.as_deref())?,
        })
    }

    pub fn get_media_link(&self, id: &str) -> Result<MediaLink> {
        self.conn
            .query_row(
                &format!("SELECT {LINK_COLUMNS} FROM media_links l WHERE l.id = ?1"),
                params![id],
                row_to_link,
            )
            .optional()?
            .ok_or_else(|| CoreError::not_found(LINK_NOT_FOUND))
    }

    /// Links of a recording version, by start time.
    pub fn list_media_links(&self, media_version_id: &str) -> Result<Vec<MediaLink>> {
        self.get_version(media_version_id)?;
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {LINK_COLUMNS} FROM media_links l WHERE l.media_version_id = ?1
             ORDER BY l.start_ms, l.end_ms, l.created_at, l.id"
        ))?;
        let rows = stmt.query_map(params![media_version_id], row_to_link)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Links whose target is this version (backlinks in the PDF/image viewer).
    pub fn list_links_for_target(&self, target_version_id: &str) -> Result<Vec<MediaLink>> {
        self.get_version(target_version_id)?;
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {LINK_COLUMNS} FROM media_links l WHERE l.target_version_id = ?1
             ORDER BY l.target_page, l.media_title, l.start_ms, l.id"
        ))?;
        let rows = stmt.query_map(params![target_version_id], row_to_link)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn create_media_link(&mut self, input: &MediaLinkInput) -> Result<MediaLink> {
        let c = self.check_link(input)?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = now(&self.conn)?;
        self.conn.execute(
            "INSERT INTO media_links (id, project_id, media_document_id, media_version_id,
                 start_ms, end_ms, target_document_id, target_version_id, target_page,
                 region_x, region_y, region_w, region_h, note, media_title, target_title,
                 created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                 ?17, ?17)",
            params![
                id,
                c.project_id,
                c.media_document_id,
                input.media_version_id,
                c.start_ms,
                c.end_ms,
                c.target_document_id,
                input.target_version_id,
                c.target_page,
                c.region.map(|r| r.x),
                c.region.map(|r| r.y),
                c.region.map(|r| r.w),
                c.region.map(|r| r.h),
                c.note,
                c.media_title,
                c.target_title,
                now
            ],
        )?;
        self.get_media_link(&id)
    }

    /// Replaces every field of a link (same validations as create).
    pub fn update_media_link(&mut self, id: &str, input: &MediaLinkInput) -> Result<MediaLink> {
        self.get_media_link(id)?;
        let c = self.check_link(input)?;
        let now = now(&self.conn)?;
        let changed = self.conn.execute(
            "UPDATE media_links SET project_id = ?2, media_document_id = ?3,
                 media_version_id = ?4, start_ms = ?5, end_ms = ?6, target_document_id = ?7,
                 target_version_id = ?8, target_page = ?9, region_x = ?10, region_y = ?11,
                 region_w = ?12, region_h = ?13, note = ?14, media_title = ?15,
                 target_title = ?16, updated_at = ?17
             WHERE id = ?1",
            params![
                id,
                c.project_id,
                c.media_document_id,
                input.media_version_id,
                c.start_ms,
                c.end_ms,
                c.target_document_id,
                input.target_version_id,
                c.target_page,
                c.region.map(|r| r.x),
                c.region.map(|r| r.y),
                c.region.map(|r| r.w),
                c.region.map(|r| r.h),
                c.note,
                c.media_title,
                c.target_title,
                now
            ],
        )?;
        if changed == 0 {
            return Err(CoreError::not_found(LINK_NOT_FOUND));
        }
        self.get_media_link(id)
    }

    pub fn delete_media_link(&mut self, id: &str) -> Result<()> {
        let changed = self
            .conn
            .execute("DELETE FROM media_links WHERE id = ?1", params![id])?;
        if changed == 0 {
            return Err(CoreError::not_found(LINK_NOT_FOUND));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn region_rules() {
        let r = |x, y, w, h| Some(Region { x, y, w, h });
        assert!(validate_region(None).unwrap().is_none());
        assert!(validate_region(r(0.0, 0.0, 1.0, 1.0)).is_ok());
        assert!(validate_region(r(0.7, 0.2, 0.3, 0.3)).is_ok());
        for bad in [
            r(-0.1, 0.0, 0.5, 0.5),
            r(0.0, 0.0, 0.0, 0.5),
            r(0.0, 0.0, 0.5, -0.1),
            r(0.6, 0.0, 0.5, 0.5),
            r(0.0, 0.9, 0.5, 0.2),
            r(f64::NAN, 0.0, 0.5, 0.5),
            r(0.0, 0.0, f64::INFINITY, 0.5),
        ] {
            assert!(validate_region(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn note_rules() {
        assert_eq!(validate_note(Some("  ")).unwrap(), None);
        assert_eq!(validate_note(Some(" a\nb ")).unwrap().as_deref(), Some("a\nb"));
        assert!(validate_note(Some(&"è".repeat(LINK_NOTE_MAX))).is_ok());
        assert!(validate_note(Some(&"è".repeat(LINK_NOTE_MAX + 1))).is_err());
        assert!(validate_note(Some("a\u{0}b")).is_err());
    }
}
