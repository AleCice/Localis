//! Localis domain logic and SQLite persistence. No Tauri dependency, so it can be
//! tested without GUI system libraries.

mod blobs;
mod error;
pub mod extract;
mod formats;
mod jobs;
mod library;
mod search;
mod store;
mod validation;

pub use blobs::sha256_hex;
pub use error::{CoreError, Result};
pub use formats::{detect_format, DetectedFormat, DocumentKind};
pub use jobs::{
    run_worker, ClaimedJob, Job, JobState, WorkerConfig, JOBS_LIST_MAX, JOB_KIND_EXTRACT_TEXT,
};
pub use library::{
    check_size, DocumentVersion, Folder, ImportFile, ImportOutcome, LibraryDocument, NewFolder,
    TextStatus, TextUnit, FILE_NAME_MAX, IMPORT_MAX_BYTES,
};
pub use search::{
    fts_query, SearchHit, UnitKind, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, SNIPPET_MARK_END,
    SNIPPET_MARK_START,
};
pub use store::{NewProject, Project, Store, ORIGINALS_DIR, SCHEMA_VERSION};
pub use validation::{validate_description, validate_name, DESCRIPTION_MAX, NAME_MAX};
