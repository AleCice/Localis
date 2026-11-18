use std::sync::mpsc::SyncSender;
use std::sync::{Mutex, MutexGuard};

use localis_core::{
    DocumentVersion, Folder, ImportFile, ImportOutcome, Job, LibraryDocument, NewFolder,
    NewProject, Project, SearchHit, Store, TextUnit,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Request, Response};
use tauri::State;

use crate::error::AppError;
use crate::headers::{raw_body, ImportHeaders, VersionHeaders};

type Opener = Box<dyn Fn() -> Result<Store, AppError> + Send + Sync>;

/// Managed state: the store, opened lazily. If opening fails, the error is returned to
/// the UI and the next command tries again, so «Riprova» can recover from a transient
/// failure (e.g. the database locked by another process) without restarting the app.
pub struct AppState {
    opener: Opener,
    store: Mutex<Option<Store>>,
    /// Wakes the background extraction worker (capacity 1: wake-ups coalesce).
    worker: Option<SyncSender<()>>,
}

impl AppState {
    pub fn new(opener: impl Fn() -> Result<Store, AppError> + Send + Sync + 'static) -> Self {
        let store = opener().ok();
        AppState {
            opener: Box::new(opener),
            store: Mutex::new(store),
            worker: None,
        }
    }

    pub fn with_worker(mut self, wake: SyncSender<()>) -> Self {
        self.worker = Some(wake);
        self
    }

    /// Signals the worker that jobs may be queued. Never blocks.
    pub(crate) fn wake_worker(&self) {
        if let Some(wake) = &self.worker {
            let _ = wake.try_send(());
        }
    }

    /// Runs `f` with the open store, opening it first if needed.
    pub(crate) fn with_store<R>(
        &self,
        f: impl FnOnce(&mut Store) -> Result<R, AppError>,
    ) -> Result<R, AppError> {
        let mut guard: MutexGuard<'_, Option<Store>> = self
            .store
            .lock()
            .map_err(|_| AppError::internal("store mutex poisoned"))?;
        if guard.is_none() {
            *guard = Some((self.opener)()?);
        }
        match guard.as_mut() {
            Some(store) => f(store),
            None => Err(AppError::internal("store not available")),
        }
    }
}

/// `Project` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDto {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl From<Project> for ProjectDto {
    fn from(p: Project) -> Self {
        ProjectDto {
            id: p.id,
            name: p.name,
            description: p.description,
            created_at: p.created_at,
            updated_at: p.updated_at,
        }
    }
}

/// `NewProjectInput` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProjectInput {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

// Commands are async so they run off the main (UI) thread. They never await while
// holding the lock.

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> Result<Vec<ProjectDto>, AppError> {
    state.with_store(|store| {
        Ok(store
            .list_projects()?
            .into_iter()
            .map(ProjectDto::from)
            .collect())
    })
}

#[tauri::command]
pub async fn create_project(
    state: State<'_, AppState>,
    input: NewProjectInput,
) -> Result<ProjectDto, AppError> {
    state.with_store(|store| {
        let project = store.create_project(NewProject {
            name: input.name,
            description: input.description,
        })?;
        Ok(project.into())
    })
}

#[tauri::command]
pub async fn delete_project(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.with_store(|store| Ok(store.delete_project(&id)?))
}

// ---------------------------------------------------------------- v0.2 Library

/// `Folder` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderDto {
    pub id: String,
    pub project_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<Folder> for FolderDto {
    fn from(f: Folder) -> Self {
        FolderDto {
            id: f.id,
            project_id: f.project_id,
            parent_id: f.parent_id,
            name: f.name,
            created_at: f.created_at,
            updated_at: f.updated_at,
        }
    }
}

/// `NewFolderInput` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewFolderInput {
    pub project_id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub name: String,
}

/// `DocumentVersion` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentVersionDto {
    pub id: String,
    pub document_id: String,
    pub version_no: u32,
    pub original_name: String,
    pub kind: &'static str,
    pub media_type: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub source_modified_at: Option<String>,
    pub imported_at: String,
    pub text_status: &'static str,
    pub page_count: Option<u32>,
    pub image_width: Option<u32>,
    pub image_height: Option<u32>,
}

impl From<DocumentVersion> for DocumentVersionDto {
    fn from(v: DocumentVersion) -> Self {
        DocumentVersionDto {
            id: v.id,
            document_id: v.document_id,
            version_no: v.version_no,
            original_name: v.original_name,
            kind: v.kind.as_str(),
            media_type: v.media_type,
            size_bytes: v.size_bytes,
            sha256: v.sha256,
            source_modified_at: v.source_modified_at,
            imported_at: v.imported_at,
            text_status: v.text_status.as_str(),
            page_count: v.page_count,
            image_width: v.image_width,
            image_height: v.image_height,
        }
    }
}

/// `LibraryDocument` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryDocumentDto {
    pub id: String,
    pub project_id: String,
    pub folder_id: Option<String>,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub current: DocumentVersionDto,
    pub version_count: u32,
}

impl From<LibraryDocument> for LibraryDocumentDto {
    fn from(d: LibraryDocument) -> Self {
        LibraryDocumentDto {
            id: d.id,
            project_id: d.project_id,
            folder_id: d.folder_id,
            title: d.title,
            created_at: d.created_at,
            updated_at: d.updated_at,
            current: d.current.into(),
            version_count: d.version_count,
        }
    }
}

/// `ImportResult` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ImportResultDto {
    Imported { document: LibraryDocumentDto },
    Duplicate { document: LibraryDocumentDto },
}

impl From<ImportOutcome> for ImportResultDto {
    fn from(outcome: ImportOutcome) -> Self {
        match outcome {
            ImportOutcome::Imported(d) => ImportResultDto::Imported { document: d.into() },
            ImportOutcome::Duplicate(d) => ImportResultDto::Duplicate { document: d.into() },
        }
    }
}

/// `TextUnit` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextUnitDto {
    pub unit: u32,
    pub text: String,
}

impl From<TextUnit> for TextUnitDto {
    fn from(u: TextUnit) -> Self {
        TextUnitDto {
            unit: u.unit,
            text: u.text,
        }
    }
}

/// Input of `search` (`{ projectId, query, limit }`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchInput {
    pub project_id: String,
    pub query: String,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `SearchHit` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHitDto {
    pub document_id: String,
    pub version_id: String,
    pub title: String,
    pub folder_id: Option<String>,
    pub unit: u32,
    pub unit_kind: &'static str,
    pub snippet: String,
}

impl From<SearchHit> for SearchHitDto {
    fn from(h: SearchHit) -> Self {
        SearchHitDto {
            document_id: h.document_id,
            version_id: h.version_id,
            title: h.title,
            folder_id: h.folder_id,
            unit: h.unit,
            unit_kind: h.unit_kind.as_str(),
            snippet: h.snippet,
        }
    }
}

/// `Job` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDto {
    pub id: i64,
    pub document_id: String,
    pub version_id: String,
    pub kind: String,
    pub state: &'static str,
    pub attempts: u32,
    pub error: Option<String>,
    pub error_detail: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl From<Job> for JobDto {
    fn from(j: Job) -> Self {
        JobDto {
            id: j.id,
            document_id: j.document_id,
            version_id: j.version_id,
            kind: j.kind,
            state: j.state.as_str(),
            attempts: j.attempts,
            error: j.error,
            error_detail: j.error_detail,
            created_at: j.created_at,
            updated_at: j.updated_at,
        }
    }
}

fn map_all<T, D: From<T>>(items: Vec<T>) -> Vec<D> {
    items.into_iter().map(D::from).collect()
}

#[tauri::command]
pub async fn list_folders(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<FolderDto>, AppError> {
    state.with_store(|store| Ok(map_all(store.list_folders(&project_id)?)))
}

#[tauri::command]
pub async fn create_folder(
    state: State<'_, AppState>,
    input: NewFolderInput,
) -> Result<FolderDto, AppError> {
    state.with_store(|store| {
        Ok(store
            .create_folder(NewFolder {
                project_id: input.project_id,
                parent_id: input.parent_id,
                name: input.name,
            })?
            .into())
    })
}

#[tauri::command]
pub async fn rename_folder(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<FolderDto, AppError> {
    state.with_store(|store| Ok(store.rename_folder(&id, &name)?.into()))
}

#[tauri::command]
pub async fn delete_folder(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.with_store(|store| Ok(store.delete_folder(&id)?))
}

#[tauri::command]
pub async fn list_documents(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<LibraryDocumentDto>, AppError> {
    state.with_store(|store| Ok(map_all(store.list_documents(&project_id)?)))
}

#[tauri::command]
pub async fn list_versions(
    state: State<'_, AppState>,
    document_id: String,
) -> Result<Vec<DocumentVersionDto>, AppError> {
    state.with_store(|store| Ok(map_all(store.list_versions(&document_id)?)))
}

/// Raw body: the bytes of a file the user picked in the webview. Metadata in headers.
#[tauri::command]
pub async fn import_document(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<ImportResultDto, AppError> {
    let bytes = raw_body(request.body())?;
    let meta = ImportHeaders::parse(request.headers())?;
    // Validation, format detection and hashing happen before taking the store lock.
    let file = ImportFile::prepare(&meta.file_name, meta.last_modified, bytes)?;
    let outcome = state.with_store(|store| {
        Ok(store.import_document(&meta.project_id, meta.folder_id.as_deref(), &file)?)
    })?;
    if matches!(outcome, ImportOutcome::Imported(_)) {
        state.wake_worker();
    }
    Ok(outcome.into())
}

#[tauri::command]
pub async fn import_version(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<LibraryDocumentDto, AppError> {
    let bytes = raw_body(request.body())?;
    let meta = VersionHeaders::parse(request.headers())?;
    let file = ImportFile::prepare(&meta.file_name, meta.last_modified, bytes)?;
    let document = state.with_store(|store| Ok(store.import_version(&meta.document_id, &file)?))?;
    state.wake_worker();
    Ok(document.into())
}

#[tauri::command]
pub async fn move_document(
    state: State<'_, AppState>,
    id: String,
    folder_id: Option<String>,
) -> Result<LibraryDocumentDto, AppError> {
    state.with_store(|store| Ok(store.move_document(&id, folder_id.as_deref())?.into()))
}

#[tauri::command]
pub async fn delete_document(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.with_store(|store| Ok(store.delete_document(&id)?))
}

/// Raw response: the verified bytes of the stored original (`ArrayBuffer` in JS).
#[tauri::command]
pub async fn read_original(
    state: State<'_, AppState>,
    version_id: String,
) -> Result<Response, AppError> {
    let bytes = state.with_store(|store| Ok(store.read_original(&version_id)?))?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn get_text(
    state: State<'_, AppState>,
    version_id: String,
) -> Result<Vec<TextUnitDto>, AppError> {
    state.with_store(|store| Ok(map_all(store.get_text(&version_id)?)))
}

#[tauri::command]
pub async fn search(
    state: State<'_, AppState>,
    input: SearchInput,
) -> Result<Vec<SearchHitDto>, AppError> {
    state.with_store(|store| {
        Ok(map_all(store.search(
            &input.project_id,
            &input.query,
            input.limit,
        )?))
    })
}

#[tauri::command]
pub async fn list_jobs(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<JobDto>, AppError> {
    state.with_store(|store| Ok(map_all(store.list_jobs(&project_id)?)))
}

#[tauri::command]
pub async fn retry_job(state: State<'_, AppState>, id: i64) -> Result<JobDto, AppError> {
    let job = state.with_store(|store| Ok(store.retry_job(id)?))?;
    state.wake_worker();
    Ok(job.into())
}
