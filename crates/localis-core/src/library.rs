//! Document library: folders, documents with versions, import of originals, extracted text.

use rusqlite::types::Type;
use rusqlite::{params, OptionalExtension, Row, TransactionBehavior};

use crate::blobs::sha256_hex;
use crate::error::{CoreError, Result};
use crate::formats::{detect_format, detect_media_file, DetectedFormat, DocumentKind};
use crate::store::{now, Store};
use crate::validation::{name_key, validate_name};

/// Max size of a single imported file.
pub const IMPORT_MAX_BYTES: usize = 200 * 1024 * 1024;
pub const FILE_NAME_MAX: usize = 255;

const FOLDER_NOT_FOUND: &str = "La cartella non esiste più.";
const DOCUMENT_NOT_FOUND: &str = "Il documento non esiste più.";
const VERSION_NOT_FOUND: &str = "La versione del documento non esiste più.";
const FOLDER_DUPLICATE: &str = "Esiste già una cartella con questo nome.";
const FOLDER_NOT_EMPTY: &str = "La cartella non è vuota.";
const FOLDER_OTHER_PROJECT: &str = "La cartella non appartiene a questo progetto.";
const FILE_NAME_INVALID: &str = "Il nome del file non è valido.";
const FILE_EMPTY: &str = "Il file è vuoto.";
const FILE_TOO_LARGE: &str = "Il file supera il limite di 200 MB.";
const MEDIA_TOO_LARGE: &str = "Il file audio/video supera il limite di 4 GB.";
const SAME_KIND_REQUIRED: &str = "La nuova versione deve essere dello stesso formato.";
const VERSION_DUPLICATE: &str = "Questa versione è già presente nel documento.";

/// A folder inside a project (`parent_id = None` means the project root).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Folder {
    pub id: String,
    pub project_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Unvalidated input for [`Store::create_folder`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NewFolder {
    pub project_id: String,
    pub parent_id: Option<String>,
    pub name: String,
}

/// State of the searchable text of a version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextStatus {
    Pending,
    Extracted,
    NoText,
    Failed,
    NotApplicable,
}

impl TextStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TextStatus::Pending => "pending",
            TextStatus::Extracted => "extracted",
            TextStatus::NoText => "no_text",
            TextStatus::Failed => "failed",
            TextStatus::NotApplicable => "not_applicable",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "pending" => TextStatus::Pending,
            "extracted" => TextStatus::Extracted,
            "no_text" => TextStatus::NoText,
            "failed" => TextStatus::Failed,
            "not_applicable" => TextStatus::NotApplicable,
            _ => return None,
        })
    }
}

/// One stored version of a document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentVersion {
    pub id: String,
    pub document_id: String,
    /// 1-based.
    pub version_no: u32,
    pub original_name: String,
    pub kind: DocumentKind,
    pub media_type: String,
    pub size_bytes: u64,
    /// Lowercase hex sha256 of the original bytes.
    pub sha256: String,
    pub source_modified_at: Option<String>,
    pub imported_at: String,
    pub text_status: TextStatus,
    pub page_count: Option<u32>,
    pub image_width: Option<u32>,
    pub image_height: Option<u32>,
    /// v0.5: audio/video duration in milliseconds, when known.
    pub duration_ms: Option<u64>,
    /// v0.5: the current transcript of an audio/video version, if any.
    pub transcription: Option<TranscriptionInfo>,
}

/// Summary of the transcript of an audio/video version (`TranscriptionInfo` in types.ts).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptionInfo {
    /// Whisper model id (`tiny`, `base`, `small`, `large-v3-turbo-q5`).
    pub model: String,
    /// Detected or chosen ISO 639-1 code.
    pub language: String,
    pub created_at: String,
    pub segment_count: u32,
}

/// A document with its current (latest) version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryDocument {
    pub id: String,
    pub project_id: String,
    pub folder_id: Option<String>,
    /// Original name of the first version.
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub current: DocumentVersion,
    pub version_count: u32,
}

/// Result of [`Store::import_document`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImportOutcome {
    Imported(LibraryDocument),
    /// Same bytes already present in the project: nothing was imported.
    Duplicate(LibraryDocument),
}

/// One unit of extracted text: a PDF page, a text block/paragraph or (v0.5) a transcript
/// segment (1-based).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextUnit {
    pub unit: u32,
    pub text: String,
    /// Transcript segments only.
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
}

/// Where the bytes of a file being imported are.
#[derive(Debug, Clone)]
enum ImportSource<'a> {
    /// Received whole (at most [`IMPORT_MAX_BYTES`]).
    Bytes(&'a [u8]),
    /// v0.5: assembled by a chunked upload in a temporary file inside the originals
    /// directory; moved (renamed) into the archive on import.
    TempFile(std::path::PathBuf),
}

/// A file ready to be imported: validated, recognized and hashed. Building it needs no
/// database access, so callers can do it before taking any lock.
#[derive(Debug, Clone)]
pub struct ImportFile<'a> {
    source: ImportSource<'a>,
    size: u64,
    file_name: String,
    format: DetectedFormat,
    sha256: String,
    source_modified_at: Option<String>,
}

impl<'a> ImportFile<'a> {
    /// Validates name and size, recognizes the format and computes the sha256.
    /// `last_modified_ms` is the file's modification time in ms since the Unix epoch;
    /// values outside years 1970–9999 are ignored.
    pub fn prepare(
        file_name: &str,
        last_modified_ms: Option<i64>,
        bytes: &'a [u8],
    ) -> Result<Self> {
        let file_name = validate_file_name(file_name)?;
        check_size(bytes.len())?;
        let format = detect_format(&file_name, bytes)?;
        Ok(ImportFile {
            source: ImportSource::Bytes(bytes),
            size: bytes.len() as u64,
            file_name,
            format,
            sha256: sha256_hex(bytes),
            source_modified_at: last_modified_ms.and_then(iso_from_millis),
        })
    }

    /// v0.5: a file assembled by a chunked upload at `path` (inside the originals
    /// directory), with its size and sha256 computed while it was received. Audio/video are
    /// probed from the file; other formats (at most 200 MB) are read to be recognized.
    pub fn prepare_temp_file(
        file_name: &str,
        last_modified_ms: Option<i64>,
        path: &std::path::Path,
        size: u64,
        sha256: &str,
    ) -> Result<ImportFile<'static>> {
        let file_name = validate_file_name(file_name)?;
        if size == 0 {
            return Err(CoreError::validation("file", FILE_EMPTY));
        }
        let format = match detect_media_file(&file_name, path)? {
            Some(format) => format,
            None => {
                check_size(usize::try_from(size).unwrap_or(usize::MAX))?;
                let bytes = std::fs::read(path).map_err(|err| {
                    CoreError::storage(
                        "Impossibile leggere il file caricato.",
                        format!("{}: {err}", path.display()),
                    )
                })?;
                detect_format(&file_name, &bytes)?
            }
        };
        check_kind_size(format.kind, size)?;
        Ok(ImportFile {
            source: ImportSource::TempFile(path.to_path_buf()),
            size,
            file_name,
            format,
            sha256: sha256.to_owned(),
            source_modified_at: last_modified_ms.and_then(iso_from_millis),
        })
    }

    pub fn file_name(&self) -> &str {
        &self.file_name
    }

    pub fn format(&self) -> &DetectedFormat {
        &self.format
    }

    pub fn sha256(&self) -> &str {
        &self.sha256
    }

    pub fn size(&self) -> u64 {
        self.size
    }
}

/// v0.5: size limit by kind (audio/video 4 GB, others 200 MB).
pub fn check_kind_size(kind: DocumentKind, size: u64) -> Result<()> {
    if size == 0 {
        return Err(CoreError::validation("file", FILE_EMPTY));
    }
    if size > kind.max_bytes() {
        return Err(CoreError::TooLarge {
            message: if kind.is_media() {
                MEDIA_TOO_LARGE
            } else {
                FILE_TOO_LARGE
            }
            .to_owned(),
        });
    }
    Ok(())
}

/// Rejects empty and over-limit sizes (`validation` / `too_large`).
pub fn check_size(len: usize) -> Result<()> {
    if len == 0 {
        return Err(CoreError::validation("file", FILE_EMPTY));
    }
    if len > IMPORT_MAX_BYTES {
        return Err(CoreError::TooLarge {
            message: FILE_TOO_LARGE.to_owned(),
        });
    }
    Ok(())
}

pub(crate) fn validate_file_name(raw: &str) -> Result<String> {
    let name = raw.trim();
    if name.is_empty()
        || name.chars().count() > FILE_NAME_MAX
        || name
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return Err(CoreError::validation("file", FILE_NAME_INVALID));
    }
    Ok(name.to_owned())
}

/// ISO 8601 UTC with milliseconds for `ms` since the Unix epoch (years 1970–9999 only).
pub(crate) fn iso_from_millis(ms: i64) -> Option<String> {
    const MAX_MS: i64 = 253_402_300_799_999; // 9999-12-31T23:59:59.999Z
    if !(0..=MAX_MS).contains(&ms) {
        return None;
    }
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    ))
}

#[derive(Debug)]
struct BadValue(String);

impl std::fmt::Display for BadValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "unexpected stored value {:?}", self.0)
    }
}

impl std::error::Error for BadValue {}

fn bad_value(idx: usize, value: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(idx, Type::Text, Box::new(BadValue(value)))
}

const VERSION_COLUMNS: &str = "v.id, v.document_id, v.version_no, v.original_name, v.kind,
    v.media_type, v.size_bytes, v.sha256, v.source_modified_at, v.imported_at, v.text_status,
    v.page_count, v.image_width, v.image_height, v.duration_ms,
    (SELECT t.model FROM transcriptions t WHERE t.version_id = v.id),
    (SELECT t.language FROM transcriptions t WHERE t.version_id = v.id),
    (SELECT t.created_at FROM transcriptions t WHERE t.version_id = v.id),
    (SELECT t.segment_count FROM transcriptions t WHERE t.version_id = v.id)";

fn row_to_version(row: &Row<'_>, at: usize) -> rusqlite::Result<DocumentVersion> {
    let kind: String = row.get(at + 4)?;
    let status: String = row.get(at + 10)?;
    Ok(DocumentVersion {
        id: row.get(at)?,
        document_id: row.get(at + 1)?,
        version_no: row.get(at + 2)?,
        original_name: row.get(at + 3)?,
        kind: DocumentKind::parse(&kind).ok_or_else(|| bad_value(at + 4, kind.clone()))?,
        media_type: row.get(at + 5)?,
        size_bytes: u64::try_from(row.get::<_, i64>(at + 6)?).unwrap_or(0),
        sha256: row.get(at + 7)?,
        source_modified_at: row.get(at + 8)?,
        imported_at: row.get(at + 9)?,
        text_status: TextStatus::parse(&status)
            .ok_or_else(|| bad_value(at + 10, status.clone()))?,
        page_count: row.get(at + 11)?,
        image_width: row.get(at + 12)?,
        image_height: row.get(at + 13)?,
        duration_ms: row
            .get::<_, Option<i64>>(at + 14)?
            .and_then(|d| u64::try_from(d).ok()),
        transcription: match row.get::<_, Option<String>>(at + 15)? {
            Some(model) => Some(TranscriptionInfo {
                model,
                language: row.get(at + 16)?,
                created_at: row.get(at + 17)?,
                segment_count: row.get(at + 18)?,
            }),
            None => None,
        },
    })
}

/// Documents joined with their current version; append a WHERE clause.
fn document_select() -> String {
    format!(
        "SELECT d.id, d.project_id, d.folder_id, d.title, d.created_at, d.updated_at,
                (SELECT COUNT(*) FROM document_versions c WHERE c.document_id = d.id),
                {VERSION_COLUMNS}
         FROM documents d
         JOIN document_versions v ON v.document_id = d.id
          AND v.version_no = (SELECT MAX(m.version_no) FROM document_versions m
                              WHERE m.document_id = d.id)"
    )
}

fn row_to_document(row: &Row<'_>) -> rusqlite::Result<LibraryDocument> {
    Ok(LibraryDocument {
        id: row.get(0)?,
        project_id: row.get(1)?,
        folder_id: row.get(2)?,
        title: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        version_count: row.get(6)?,
        current: row_to_version(row, 7)?,
    })
}

fn row_to_folder(row: &Row<'_>) -> rusqlite::Result<Folder> {
    Ok(Folder {
        id: row.get(0)?,
        project_id: row.get(1)?,
        parent_id: row.get(2)?,
        name: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

const FOLDER_COLUMNS: &str = "id, project_id, parent_id, name, created_at, updated_at";

impl Store {
    // ------------------------------------------------------------------ folders

    /// Folders of the project, sorted by name (case-insensitive).
    pub fn list_folders(&self, project_id: &str) -> Result<Vec<Folder>> {
        self.ensure_project(project_id)?;
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {FOLDER_COLUMNS} FROM folders WHERE project_id = ?1"
        ))?;
        let mut folders = stmt
            .query_map(params![project_id], row_to_folder)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        folders.sort_by_cached_key(|f| (name_key(&f.name), f.id.clone()));
        Ok(folders)
    }

    pub fn get_folder(&self, id: &str) -> Result<Folder> {
        self.conn
            .query_row(
                &format!("SELECT {FOLDER_COLUMNS} FROM folders WHERE id = ?1"),
                params![id],
                row_to_folder,
            )
            .optional()?
            .ok_or_else(|| CoreError::not_found(FOLDER_NOT_FOUND))
    }

    /// Checks that folder `id` exists and belongs to `project_id`.
    fn folder_in_project(&self, id: &str, project_id: &str, field: &'static str) -> Result<()> {
        let folder = self.get_folder(id)?;
        if folder.project_id != project_id {
            return Err(CoreError::validation(field, FOLDER_OTHER_PROJECT));
        }
        Ok(())
    }

    fn check_sibling_name(
        &self,
        project_id: &str,
        parent_id: Option<&str>,
        name: &str,
        exclude_id: Option<&str>,
    ) -> Result<()> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, name FROM folders WHERE project_id = ?1 AND parent_id IS ?2")?;
        let mut rows = stmt.query(params![project_id, parent_id])?;
        let key = name_key(name);
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            if Some(id.as_str()) != exclude_id && name_key(&row.get::<_, String>(1)?) == key {
                return Err(CoreError::Duplicate {
                    field: "name",
                    message: FOLDER_DUPLICATE.to_owned(),
                });
            }
        }
        Ok(())
    }

    pub fn create_folder(&mut self, input: NewFolder) -> Result<Folder> {
        let name = validate_name(&input.name)?;
        self.ensure_project(&input.project_id)?;
        let parent_id = input.parent_id.filter(|p| !p.is_empty());
        if let Some(parent) = &parent_id {
            self.folder_in_project(parent, &input.project_id, "parentId")?;
        }
        self.check_sibling_name(&input.project_id, parent_id.as_deref(), &name, None)?;
        let now = now(&self.conn)?;
        let folder = Folder {
            id: uuid::Uuid::new_v4().to_string(),
            project_id: input.project_id,
            parent_id,
            name,
            created_at: now.clone(),
            updated_at: now,
        };
        self.conn.execute(
            "INSERT INTO folders (id, project_id, parent_id, name, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                folder.id,
                folder.project_id,
                folder.parent_id,
                folder.name,
                folder.created_at,
                folder.updated_at
            ],
        )?;
        Ok(folder)
    }

    pub fn rename_folder(&mut self, id: &str, name: &str) -> Result<Folder> {
        let name = validate_name(name)?;
        let folder = self.get_folder(id)?;
        self.check_sibling_name(
            &folder.project_id,
            folder.parent_id.as_deref(),
            &name,
            Some(id),
        )?;
        let now = now(&self.conn)?;
        self.conn.execute(
            "UPDATE folders SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, name, now],
        )?;
        self.get_folder(id)
    }

    /// Deletes an empty folder (`conflict` if it has documents or subfolders).
    pub fn delete_folder(&mut self, id: &str) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM folders WHERE id = ?1)",
            params![id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(CoreError::not_found(FOLDER_NOT_FOUND));
        }
        let busy: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM folders WHERE parent_id = ?1)
                 OR EXISTS (SELECT 1 FROM documents WHERE folder_id = ?1)",
            params![id],
            |r| r.get(0),
        )?;
        if busy {
            return Err(CoreError::conflict(FOLDER_NOT_EMPTY));
        }
        tx.execute("DELETE FROM folders WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    // ---------------------------------------------------------------- documents

    /// All documents of the project, sorted by title (case-insensitive).
    pub fn list_documents(&self, project_id: &str) -> Result<Vec<LibraryDocument>> {
        self.ensure_project(project_id)?;
        let mut stmt = self
            .conn
            .prepare(&format!("{} WHERE d.project_id = ?1", document_select()))?;
        let mut docs = stmt
            .query_map(params![project_id], row_to_document)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        docs.sort_by_cached_key(|d| (d.title.to_lowercase(), d.created_at.clone(), d.id.clone()));
        Ok(docs)
    }

    pub fn get_document(&self, id: &str) -> Result<LibraryDocument> {
        self.conn
            .query_row(
                &format!("{} WHERE d.id = ?1", document_select()),
                params![id],
                row_to_document,
            )
            .optional()?
            .ok_or_else(|| CoreError::not_found(DOCUMENT_NOT_FOUND))
    }

    /// All versions of a document, newest first.
    pub fn list_versions(&self, document_id: &str) -> Result<Vec<DocumentVersion>> {
        self.get_document(document_id)?;
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {VERSION_COLUMNS} FROM document_versions v
             WHERE v.document_id = ?1 ORDER BY v.version_no DESC"
        ))?;
        let versions = stmt
            .query_map(params![document_id], |row| row_to_version(row, 0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(versions)
    }

    pub fn get_version(&self, id: &str) -> Result<DocumentVersion> {
        self.conn
            .query_row(
                &format!("SELECT {VERSION_COLUMNS} FROM document_versions v WHERE v.id = ?1"),
                params![id],
                |row| row_to_version(row, 0),
            )
            .optional()?
            .ok_or_else(|| CoreError::not_found(VERSION_NOT_FOUND))
    }

    /// Imports a new document into the project (or the folder). If the same bytes are
    /// already in the project, nothing is imported and the existing document is returned.
    pub fn import_document(
        &mut self,
        project_id: &str,
        folder_id: Option<&str>,
        file: &ImportFile<'_>,
    ) -> Result<ImportOutcome> {
        self.blobs()?;
        self.ensure_project(project_id)?;
        let folder_id = folder_id.filter(|f| !f.is_empty());
        if let Some(folder) = folder_id {
            self.folder_in_project(folder, project_id, "folderId")?;
        }
        let existing: Option<String> = self
            .conn
            .query_row(
                "SELECT d.id FROM document_versions v
                 JOIN documents d ON d.id = v.document_id
                 WHERE d.project_id = ?1 AND v.sha256 = ?2
                 ORDER BY d.created_at, d.id LIMIT 1",
                params![project_id, file.sha256],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = existing {
            return Ok(ImportOutcome::Duplicate(self.get_document(&id)?));
        }

        self.put_import_blob(file)?;
        let document_id = uuid::Uuid::new_v4().to_string();
        let inserted = (|| -> Result<()> {
            let tx = self
                .conn
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now = now(&tx)?;
            tx.execute(
                "INSERT INTO documents (id, project_id, folder_id, title, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![document_id, project_id, folder_id, file.file_name, now],
            )?;
            insert_version(&tx, &document_id, 1, file, &now)?;
            tx.commit()?;
            Ok(())
        })();
        if let Err(err) = inserted {
            self.gc_blobs([file.sha256.clone()]);
            return Err(err);
        }
        Ok(ImportOutcome::Imported(self.get_document(&document_id)?))
    }

    /// Adds a new version to a document. Must be the same kind as the current version
    /// (`validation`) and differ from every existing version (`duplicate`).
    pub fn import_version(
        &mut self,
        document_id: &str,
        file: &ImportFile<'_>,
    ) -> Result<LibraryDocument> {
        self.blobs()?;
        let document = self.get_document(document_id)?;
        if document.current.kind != file.format.kind {
            return Err(CoreError::validation("file", SAME_KIND_REQUIRED));
        }
        let duplicate: bool = self.conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM document_versions WHERE document_id = ?1 AND sha256 = ?2)",
            params![document_id, file.sha256],
            |r| r.get(0),
        )?;
        if duplicate {
            return Err(CoreError::Duplicate {
                field: "file",
                message: VERSION_DUPLICATE.to_owned(),
            });
        }

        self.put_import_blob(file)?;
        let inserted = (|| -> Result<()> {
            let tx = self
                .conn
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now = now(&tx)?;
            let next: u32 = tx.query_row(
                "SELECT COALESCE(MAX(version_no), 0) + 1 FROM document_versions WHERE document_id = ?1",
                params![document_id],
                |r| r.get(0),
            )?;
            insert_version(&tx, document_id, next, file, &now)?;
            let changed = tx.execute(
                "UPDATE documents SET updated_at = ?2 WHERE id = ?1",
                params![document_id, now],
            )?;
            if changed == 0 {
                return Err(CoreError::not_found(DOCUMENT_NOT_FOUND));
            }
            tx.commit()?;
            Ok(())
        })();
        if let Err(err) = inserted {
            self.gc_blobs([file.sha256.clone()]);
            return Err(err);
        }
        self.get_document(document_id)
    }

    /// v0.5: checks, before a chunked upload starts, that its destination exists: the
    /// project, the folder (in the project) or, for a new version, the document (in the
    /// project and of the same kind as the file).
    pub fn check_upload_target(&self, upload: &crate::uploads::BeginUpload) -> Result<()> {
        let kind = crate::formats::kind_for_file_name(&upload.file_name)?;
        self.ensure_project(&upload.project_id)?;
        if let Some(folder) = upload.folder_id.as_deref().filter(|f| !f.is_empty()) {
            self.folder_in_project(folder, &upload.project_id, "folderId")?;
        }
        if let Some(document_id) = upload.document_id.as_deref().filter(|d| !d.is_empty()) {
            let document = self.get_document(document_id)?;
            if document.project_id != upload.project_id {
                return Err(CoreError::not_found(DOCUMENT_NOT_FOUND));
            }
            if document.current.kind != kind {
                return Err(CoreError::validation("file", SAME_KIND_REQUIRED));
            }
        }
        Ok(())
    }

    /// v0.5: imports a finished chunked upload (prepared with
    /// [`crate::FinishedUpload::prepare`]) as a new document or, with `documentId`, as a new
    /// version (`Imported`). Same rules as [`Store::import_document`] and
    /// [`Store::import_version`].
    pub fn import_upload(
        &mut self,
        upload: &crate::uploads::FinishedUpload,
        file: &ImportFile<'_>,
    ) -> Result<ImportOutcome> {
        match upload.input.document_id.as_deref().filter(|d| !d.is_empty()) {
            Some(document_id) => {
                let document = self.get_document(document_id)?;
                if document.project_id != upload.input.project_id {
                    return Err(CoreError::not_found(DOCUMENT_NOT_FOUND));
                }
                Ok(ImportOutcome::Imported(self.import_version(document_id, file)?))
            }
            None => self.import_document(
                &upload.input.project_id,
                upload.input.folder_id.as_deref(),
                file,
            ),
        }
    }

    /// Moves a document to a folder of the same project, or to the root (`None`).
    pub fn move_document(&mut self, id: &str, folder_id: Option<&str>) -> Result<LibraryDocument> {
        let document = self.get_document(id)?;
        let folder_id = folder_id.filter(|f| !f.is_empty());
        if let Some(folder) = folder_id {
            self.folder_in_project(folder, &document.project_id, "folderId")?;
        }
        let now = now(&self.conn)?;
        self.conn.execute(
            "UPDATE documents SET folder_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, folder_id, now],
        )?;
        self.get_document(id)
    }

    /// Deletes the document with all versions, text and jobs, then removes the originals
    /// no other version references. Never touches user files.
    pub fn delete_document(&mut self, id: &str) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let shas = {
            let mut stmt =
                tx.prepare("SELECT DISTINCT sha256 FROM document_versions WHERE document_id = ?1")?;
            let rows = stmt.query_map(params![id], |r| r.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let changed = tx.execute("DELETE FROM documents WHERE id = ?1", params![id])?;
        if changed == 0 {
            return Err(CoreError::not_found(DOCUMENT_NOT_FOUND));
        }
        tx.commit()?;
        self.gc_blobs(shas);
        Ok(())
    }

    /// Stores the original of `file` in the archive (writing its bytes, or moving the
    /// temporary file of a chunked upload).
    fn put_import_blob(&self, file: &ImportFile<'_>) -> Result<()> {
        match &file.source {
            ImportSource::Bytes(bytes) => self.blobs()?.put(&file.sha256, bytes),
            ImportSource::TempFile(path) => self.blobs()?.put_file(&file.sha256, path),
        }
    }

    /// Bytes of the stored original of a version, verified against its sha256.
    pub fn read_original(&self, version_id: &str) -> Result<Vec<u8>> {
        let version = self.get_version(version_id)?;
        self.blobs()?.read_verified(&version.sha256)
    }

    /// Extracted text of a version, ordered by unit.
    pub fn get_text(&self, version_id: &str) -> Result<Vec<TextUnit>> {
        self.get_version(version_id)?;
        // Units of a transcript are its segments, with their time span.
        let mut stmt = self.conn.prepare(
            "SELECT t.unit, t.text, s.start_ms, s.end_ms FROM document_text t
             LEFT JOIN transcript_segments s ON s.version_id = t.version_id AND s.idx = t.unit
             WHERE t.version_id = ?1 ORDER BY t.unit",
        )?;
        let units = stmt
            .query_map(params![version_id], |r| {
                Ok(TextUnit {
                    unit: r.get(0)?,
                    text: r.get(1)?,
                    start_ms: r.get::<_, Option<i64>>(2)?.map(|v| v.max(0) as u64),
                    end_ms: r.get::<_, Option<i64>>(3)?.map(|v| v.max(0) as u64),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(units)
    }
}

fn insert_version(
    tx: &rusqlite::Transaction<'_>,
    document_id: &str,
    version_no: u32,
    file: &ImportFile<'_>,
    now: &str,
) -> Result<()> {
    let version_id = uuid::Uuid::new_v4().to_string();
    let format = &file.format;
    let status = if format.kind.has_text() {
        TextStatus::Pending
    } else {
        TextStatus::NotApplicable
    };
    tx.execute(
        "INSERT INTO document_versions (id, document_id, version_no, original_name, kind,
             media_type, size_bytes, sha256, source_modified_at, imported_at, text_status,
             page_count, image_width, image_height, duration_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, ?12, ?13, ?14)",
        params![
            version_id,
            document_id,
            version_no,
            file.file_name,
            format.kind.as_str(),
            format.media_type,
            i64::try_from(file.size).unwrap_or(i64::MAX),
            file.sha256,
            file.source_modified_at,
            now,
            status.as_str(),
            format.image_size.map(|s| s.0),
            format.image_size.map(|s| s.1),
            format
                .duration_ms
                .map(|d| i64::try_from(d).unwrap_or(i64::MAX)),
        ],
    )?;
    if format.kind.has_text() {
        tx.execute(
            "INSERT INTO jobs (version_id, kind, state, attempts, created_at, updated_at)
             VALUES (?1, 'extract_text', 'queued', 0, ?2, ?2)",
            params![version_id, now],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_from_millis_examples() {
        assert_eq!(
            iso_from_millis(0).as_deref(),
            Some("1970-01-01T00:00:00.000Z")
        );
        assert_eq!(
            iso_from_millis(1_700_000_000_123).as_deref(),
            Some("2023-11-14T22:13:20.123Z")
        );
        // Leap day.
        assert_eq!(
            iso_from_millis(951_782_400_000).as_deref(),
            Some("2000-02-29T00:00:00.000Z")
        );
        assert_eq!(
            iso_from_millis(253_402_300_799_999).as_deref(),
            Some("9999-12-31T23:59:59.999Z")
        );
        assert_eq!(iso_from_millis(-1), None);
        assert_eq!(iso_from_millis(253_402_300_800_000), None);
    }

    #[test]
    fn file_name_rules() {
        assert_eq!(validate_file_name("  note.txt ").unwrap(), "note.txt");
        for bad in ["", "   ", "a/b.txt", "a\\b.txt", "a\nb.txt"] {
            assert!(validate_file_name(bad).is_err(), "{bad:?}");
        }
        assert!(validate_file_name(&format!("{}.txt", "a".repeat(FILE_NAME_MAX))).is_err());
    }

    #[test]
    fn size_rules() {
        assert!(matches!(check_size(0), Err(CoreError::Validation { .. })));
        assert!(check_size(IMPORT_MAX_BYTES).is_ok());
        assert!(matches!(
            check_size(IMPORT_MAX_BYTES + 1),
            Err(CoreError::TooLarge { .. })
        ));
    }
}
