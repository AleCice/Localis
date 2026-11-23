use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex, MutexGuard};

use localis_core::{
    Candidate, ChatEvent, ChatMessage, ChatRuntime, CloudEmbeddingEstimate, CloudPolicy,
    CloudPreview, CloudProvider, CloudRequest, CloudRuntime, Conversation, CoreError,
    DocumentVersion, EmbedderShared, EmbeddingStatus, Endpoints, Folder, ImportFile, ImportOutcome,
    Job, KeyringStatus, LibraryDocument, LlmClient, LlmSettings, LlmStatus, ModelInfo, ModelPrice,
    ModelRef, Money, NewFolder, NewProject, PreviewSource, Project, ProviderId, RetrievalInfo,
    RouteDecision, Routing, SearchHit, SendInput, Source, Store, StoreAccess, SystemKeyring,
    TextUnit, Usage,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, Request, Response};
use tauri::{AppHandle, Manager, State};

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
    /// Running generations and their cancel flags.
    pub(crate) chat: ChatRuntime,
    /// Wakes the background embedder (capacity 1).
    embedder: Option<SyncSender<()>>,
    /// What the embedder last reported (default: not running).
    pub(crate) embedder_status: Arc<EmbedderShared>,
    /// Keychain, cloud endpoints and prepared cloud requests awaiting confirmation.
    pub(crate) cloud: CloudRuntime,
    /// v0.5: chunked uploads in progress (temporary files inside `originals/.uploads`).
    pub(crate) uploads: Option<Arc<localis_core::Uploads>>,
    /// v0.5: Whisper models (`<app_data>/models/whisper`).
    pub(crate) models: Option<Arc<localis_core::ModelManager>>,
    /// v0.5: wakes the transcription worker (capacity 1).
    transcriber: Option<SyncSender<()>>,
}

impl AppState {
    pub fn new(opener: impl Fn() -> Result<Store, AppError> + Send + Sync + 'static) -> Self {
        let store = opener().ok();
        AppState {
            opener: Box::new(opener),
            store: Mutex::new(store),
            worker: None,
            chat: ChatRuntime::new(),
            embedder: None,
            embedder_status: EmbedderShared::new(),
            cloud: CloudRuntime::new(Arc::new(SystemKeyring::new()), Endpoints::from_env()),
            uploads: None,
            models: None,
            transcriber: None,
        }
    }

    /// v0.5: chunked uploads.
    pub fn with_uploads(mut self, uploads: Arc<localis_core::Uploads>) -> Self {
        self.uploads = Some(uploads);
        self
    }

    /// v0.5: the Whisper model manager.
    pub fn with_models(mut self, models: Arc<localis_core::ModelManager>) -> Self {
        self.models = Some(models);
        self
    }

    /// v0.5: the transcription worker.
    pub fn with_transcriber(mut self, wake: SyncSender<()>) -> Self {
        self.transcriber = Some(wake);
        self
    }

    /// Signals the transcription worker that a job may be queued. Never blocks.
    pub(crate) fn wake_transcriber(&self) {
        if let Some(wake) = &self.transcriber {
            let _ = wake.try_send(());
        }
    }

    /// Uses `cloud` (keychain and endpoints shared with the embedder).
    pub fn with_cloud(mut self, cloud: CloudRuntime) -> Self {
        self.cloud = cloud;
        self
    }

    pub fn with_embedder(mut self, wake: SyncSender<()>, status: Arc<EmbedderShared>) -> Self {
        self.embedder = Some(wake);
        self.embedder_status = status;
        self
    }

    /// Signals the embedder that settings or passages changed. Never blocks.
    pub(crate) fn wake_embedder(&self) {
        if let Some(wake) = &self.embedder {
            let _ = wake.try_send(());
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

/// The chat pipeline takes the store in short sections through this trait.
impl StoreAccess for AppState {
    fn with_store<R>(
        &self,
        f: impl FnOnce(&mut Store) -> localis_core::Result<R>,
    ) -> localis_core::Result<R> {
        let mut guard = self
            .store
            .lock()
            .map_err(|_| CoreError::Internal("store mutex poisoned".into()))?;
        if guard.is_none() {
            *guard = Some((self.opener)().map_err(CoreError::from)?);
        }
        match guard.as_mut() {
            Some(store) => f(store),
            None => Err(CoreError::Internal("store not available".into())),
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
    pub cloud_policy: &'static str,
    pub cloud_embedding_consent: bool,
}

impl From<Project> for ProjectDto {
    fn from(p: Project) -> Self {
        ProjectDto {
            id: p.id,
            name: p.name,
            description: p.description,
            created_at: p.created_at,
            updated_at: p.updated_at,
            cloud_policy: p.cloud_policy.as_str(),
            cloud_embedding_consent: p.cloud_embedding_consent,
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
    /// v0.5
    pub duration_ms: Option<u64>,
    /// v0.5
    pub transcription: Option<crate::lectures::TranscriptionInfoDto>,
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
            duration_ms: v.duration_ms,
            transcription: v.transcription.map(Into::into),
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
    /// v0.5: transcript segments only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_ms: Option<u64>,
}

impl From<TextUnit> for TextUnitDto {
    fn from(u: TextUnit) -> Self {
        TextUnitDto {
            unit: u.unit,
            text: u.text,
            start_ms: u.start_ms,
            end_ms: u.end_ms,
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
    /// v0.5: segment hits only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_ms: Option<u64>,
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
            start_ms: h.start_ms,
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
    /// v0.5
    pub progress: Option<u8>,
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
            progress: j.progress,
            attempts: j.attempts,
            error: j.error,
            error_detail: j.error_detail,
            created_at: j.created_at,
            updated_at: j.updated_at,
        }
    }
}

pub(crate) fn map_all<T, D: From<T>>(items: Vec<T>) -> Vec<D> {
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
    state.wake_transcriber();
    Ok(job.into())
}

// ---------------------------------------------------------------- v0.3 Local chat

/// `ModelRef` in `src/api/types.ts` (input and output).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRefDto {
    pub provider: String,
    pub model: String,
}

impl From<ModelRef> for ModelRefDto {
    fn from(m: ModelRef) -> Self {
        ModelRefDto {
            provider: m.provider.as_str().to_owned(),
            model: m.model,
        }
    }
}

impl ModelRefDto {
    fn parse(self, field: &'static str) -> Result<ModelRef, AppError> {
        let provider = ProviderId::parse(&self.provider).ok_or_else(|| {
            AppError::from(CoreError::Validation {
                field,
                message: "Provider non valido.".to_owned(),
            })
        })?;
        Ok(ModelRef {
            provider,
            model: self.model,
        })
    }
}

fn default_routing() -> String {
    "manual".to_owned()
}

/// `LlmSettings` in `src/api/types.ts` (input and output).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmSettingsDto {
    pub base_url: String,
    #[serde(default)]
    pub chat_model: Option<ModelRefDto>,
    #[serde(default)]
    pub embedding_model: Option<ModelRefDto>,
    #[serde(default = "default_routing")]
    pub routing: String,
    #[serde(default)]
    pub auto_models: Vec<ModelRefDto>,
}

impl From<LlmSettings> for LlmSettingsDto {
    fn from(s: LlmSettings) -> Self {
        LlmSettingsDto {
            base_url: s.base_url,
            chat_model: s.chat_model.map(ModelRefDto::from),
            embedding_model: s.embedding_model.map(ModelRefDto::from),
            routing: s.routing.as_str().to_owned(),
            auto_models: map_all(s.auto_models),
        }
    }
}

impl TryFrom<LlmSettingsDto> for LlmSettings {
    type Error = AppError;

    fn try_from(s: LlmSettingsDto) -> Result<Self, AppError> {
        let routing = Routing::parse(&s.routing).ok_or_else(|| {
            AppError::from(CoreError::Validation {
                field: "routing",
                message: "Modalità di instradamento non valida.".to_owned(),
            })
        })?;
        Ok(LlmSettings {
            base_url: s.base_url,
            chat_model: s.chat_model.map(|m| m.parse("chatModel")).transpose()?,
            embedding_model: s
                .embedding_model
                .map(|m| m.parse("embeddingModel"))
                .transpose()?,
            routing,
            auto_models: s
                .auto_models
                .into_iter()
                .map(|m| m.parse("autoModels"))
                .collect::<Result<_, _>>()?,
        })
    }
}

/// `ModelInfo` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfoDto {
    pub id: String,
    pub kind: &'static str,
    pub state: Option<String>,
}

impl From<ModelInfo> for ModelInfoDto {
    fn from(m: ModelInfo) -> Self {
        ModelInfoDto {
            id: m.id,
            kind: m.kind.as_str(),
            state: m.state,
        }
    }
}

/// `LlmStatus` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmStatusDto {
    pub reachable: bool,
    pub message: Option<String>,
    pub detail: Option<String>,
    pub models: Vec<ModelInfoDto>,
}

impl From<LlmStatus> for LlmStatusDto {
    fn from(s: LlmStatus) -> Self {
        LlmStatusDto {
            reachable: s.reachable,
            message: s.message,
            detail: s.detail,
            models: map_all(s.models),
        }
    }
}

/// `EmbeddingStatus` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingStatusDto {
    pub state: &'static str,
    pub provider: Option<&'static str>,
    pub model: Option<String>,
    pub total: u64,
    pub embedded: u64,
    pub message: Option<String>,
}

impl From<EmbeddingStatus> for EmbeddingStatusDto {
    fn from(s: EmbeddingStatus) -> Self {
        EmbeddingStatusDto {
            state: s.state.as_str(),
            provider: s.provider.map(ProviderId::as_str),
            model: s.model,
            total: s.total,
            embedded: s.embedded,
            message: s.message,
        }
    }
}

/// `Conversation` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDto {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<Conversation> for ConversationDto {
    fn from(c: Conversation) -> Self {
        ConversationDto {
            id: c.id,
            project_id: c.project_id,
            title: c.title,
            created_at: c.created_at,
            updated_at: c.updated_at,
        }
    }
}

/// `RetrievalInfo` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalInfoDto {
    pub mode: &'static str,
    pub scope: &'static str,
    pub document_ids: Vec<String>,
    pub scope_reason: Option<&'static str>,
    pub embedding_model: Option<String>,
    pub embedding_provider: Option<&'static str>,
    pub query: String,
}

impl From<RetrievalInfo> for RetrievalInfoDto {
    fn from(r: RetrievalInfo) -> Self {
        RetrievalInfoDto {
            mode: r.mode.as_str(),
            scope: r.scope.as_str(),
            document_ids: r.document_ids,
            scope_reason: r.scope_reason.map(|s| s.as_str()),
            embedding_model: r.embedding_model,
            embedding_provider: r.embedding_provider.map(ProviderId::as_str),
            query: r.query,
        }
    }
}

/// `Source` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDto {
    pub rank: u32,
    pub n: Option<u32>,
    pub cited: bool,
    pub document_id: String,
    pub version_id: String,
    pub title: String,
    pub unit: u32,
    pub unit_kind: &'static str,
    pub text: String,
    /// v0.5: transcript passages only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_ms: Option<u64>,
    pub via: &'static str,
    pub available: bool,
}

impl From<Source> for SourceDto {
    fn from(s: Source) -> Self {
        SourceDto {
            rank: s.rank,
            n: s.n,
            cited: s.cited,
            document_id: s.document_id,
            version_id: s.version_id,
            title: s.title,
            unit: s.unit,
            unit_kind: s.unit_kind.as_str(),
            text: s.text,
            start_ms: s.start_ms,
            via: s.via.as_str(),
            available: s.available,
        }
    }
}

/// Element of `ChatMessage.candidates` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateDto {
    pub document_id: String,
    pub title: String,
}

impl From<Candidate> for CandidateDto {
    fn from(c: Candidate) -> Self {
        CandidateDto {
            document_id: c.document_id,
            title: c.title,
        }
    }
}

/// `ChatMessage` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageDto {
    pub id: String,
    pub conversation_id: String,
    pub role: &'static str,
    pub kind: &'static str,
    pub content: String,
    pub status: &'static str,
    pub error: Option<AppError>,
    pub model: Option<String>,
    pub provider: Option<&'static str>,
    pub route_reason: Option<String>,
    pub usage: Option<TokenUsageDto>,
    pub cost: Option<MoneyDto>,
    pub created_at: String,
    pub retrieval: Option<RetrievalInfoDto>,
    pub sources: Vec<SourceDto>,
    pub candidates: Vec<CandidateDto>,
}

impl From<ChatMessage> for ChatMessageDto {
    fn from(m: ChatMessage) -> Self {
        ChatMessageDto {
            id: m.id,
            conversation_id: m.conversation_id,
            role: m.role.as_str(),
            kind: m.kind.as_str(),
            content: m.content,
            status: m.status.as_str(),
            error: m.error.as_ref().map(AppError::from),
            model: m.model,
            provider: m.provider.map(ProviderId::as_str),
            route_reason: m.route_reason,
            usage: m.usage.map(TokenUsageDto::from),
            cost: m.cost.map(MoneyDto::from),
            created_at: m.created_at,
            retrieval: m.retrieval.map(RetrievalInfoDto::from),
            sources: map_all(m.sources),
            candidates: map_all(m.candidates),
        }
    }
}

/// `SendMessageInput` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageInput {
    pub conversation_id: String,
    pub text: String,
    #[serde(default)]
    pub document_ids: Option<Vec<String>>,
    #[serde(default)]
    pub confirm_token: Option<String>,
}

impl From<SendMessageInput> for SendInput {
    fn from(i: SendMessageInput) -> Self {
        SendInput {
            conversation_id: i.conversation_id,
            text: i.text,
            document_ids: i.document_ids.unwrap_or_default(),
            confirm_token: i.confirm_token.filter(|t| !t.is_empty()),
        }
    }
}

/// `ChatEvent` in `src/api/types.ts`: tagged by `type`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ChatEventDto {
    Accepted {
        user_message: ChatMessageDto,
        assistant_message_id: String,
    },
    Phase {
        phase: &'static str,
    },
    Delta {
        text: String,
    },
    Done {
        message: ChatMessageDto,
    },
    Error {
        error: AppError,
        message: Option<ChatMessageDto>,
    },
}

impl From<ChatEvent> for ChatEventDto {
    fn from(e: ChatEvent) -> Self {
        match e {
            ChatEvent::Accepted {
                user_message,
                assistant_message_id,
            } => ChatEventDto::Accepted {
                user_message: user_message.into(),
                assistant_message_id,
            },
            ChatEvent::Phase(phase) => ChatEventDto::Phase {
                phase: phase.as_str(),
            },
            ChatEvent::Delta(text) => ChatEventDto::Delta { text },
            ChatEvent::Done(message) => ChatEventDto::Done {
                message: message.into(),
            },
            ChatEvent::Error { error, message } => ChatEventDto::Error {
                error: AppError::from(&error),
                message: message.map(ChatMessageDto::from),
            },
        }
    }
}

/// Runs blocking work (network, long generations) off the async runtime's workers.
pub(crate) async fn blocking<R: Send + 'static>(
    f: impl FnOnce() -> Result<R, AppError> + Send + 'static,
) -> Result<R, AppError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|err| AppError::internal(format!("background task failed: {err}")))?
}

#[tauri::command]
pub async fn get_llm_settings(state: State<'_, AppState>) -> Result<LlmSettingsDto, AppError> {
    state.with_store(|store| Ok(store.llm_settings()?.into()))
}

/// Validates (loopback http only) and saves; wakes the embedder.
#[tauri::command]
pub async fn set_llm_settings(
    state: State<'_, AppState>,
    settings: LlmSettingsDto,
) -> Result<LlmSettingsDto, AppError> {
    let settings = LlmSettings::try_from(settings)?;
    let saved = state.with_store(|store| Ok(store.set_llm_settings(&settings)?))?;
    state.wake_embedder();
    Ok(saved.into())
}

/// Contacts LM Studio without holding the store. Never fails for an unreachable server.
#[tauri::command]
pub async fn get_llm_status(state: State<'_, AppState>) -> Result<LlmStatusDto, AppError> {
    let base_url = state.with_store(|store| Ok(store.llm_settings()?.base_url))?;
    blocking(move || Ok(LlmClient::new(&base_url)?.status().into())).await
}

#[tauri::command]
pub async fn get_embedding_status(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<EmbeddingStatusDto, AppError> {
    let shared = Arc::clone(&state.embedder_status);
    state.with_store(|store| Ok(store.embedding_status(&project_id, &shared)?.into()))
}

/// Most recently active first.
#[tauri::command]
pub async fn list_conversations(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<ConversationDto>, AppError> {
    state.with_store(|store| Ok(map_all(store.list_conversations(&project_id)?)))
}

#[tauri::command]
pub async fn create_conversation(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<ConversationDto, AppError> {
    state.with_store(|store| Ok(store.create_conversation(&project_id)?.into()))
}

/// Stops a running generation of the conversation, then deletes it.
#[tauri::command]
pub async fn delete_conversation(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.chat.cancel(&id);
    state.with_store(|store| Ok(store.delete_conversation(&id)?))
}

/// Chronological order.
#[tauri::command]
pub async fn list_messages(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<ChatMessageDto>, AppError> {
    state.with_store(|store| Ok(map_all(store.list_messages(&conversation_id)?)))
}

/// Streams `ChatEvent`s through `on_event`; resolves with the final assistant message.
/// Runs on a blocking thread and takes the store only in short sections.
#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    input: SendMessageInput,
    on_event: Channel<ChatEventDto>,
) -> Result<ChatMessageDto, AppError> {
    blocking(move || {
        let state = app.state::<AppState>();
        let state: &AppState = &state;
        let message =
            localis_core::send_message(state, &state.chat, &state.cloud, input.into(), &mut |e| {
                // A closed webview just stops receiving events; the answer is still stored.
                let _ = on_event.send(ChatEventDto::from(e));
            })?;
        Ok(message.into())
    })
    .await
}

/// No-op when nothing is running.
#[tauri::command]
pub async fn cancel_generation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), AppError> {
    state.chat.cancel(&conversation_id);
    Ok(())
}

// ---------------------------------------------------------------- v0.4 Cloud

/// `TokenUsage` in `src/api/types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageDto {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

impl From<Usage> for TokenUsageDto {
    fn from(u: Usage) -> Self {
        TokenUsageDto {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
        }
    }
}

/// `Money` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoneyDto {
    pub amount: f64,
    pub currency: String,
}

impl From<Money> for MoneyDto {
    fn from(m: Money) -> Self {
        MoneyDto {
            amount: m.amount,
            currency: m.currency,
        }
    }
}

/// `KeyringStatus` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyringStatusDto {
    pub available: bool,
    pub message: Option<String>,
    pub detail: Option<String>,
}

impl From<KeyringStatus> for KeyringStatusDto {
    fn from(s: KeyringStatus) -> Self {
        KeyringStatusDto {
            available: s.available,
            message: s.message,
            detail: s.detail,
        }
    }
}

/// `ProviderInfo` in `src/api/types.ts`. Says whether a key exists, never the key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfoDto {
    pub id: &'static str,
    pub name: &'static str,
    pub host: &'static str,
    pub has_key: bool,
    pub supports_chat: bool,
    pub supports_embeddings: bool,
}

impl ProviderInfoDto {
    pub fn new(p: CloudProvider, has_key: bool) -> Self {
        ProviderInfoDto {
            id: p.as_str(),
            name: p.name(),
            host: p.host(),
            has_key,
            supports_chat: p.supports_chat(),
            supports_embeddings: p.supports_embeddings(),
        }
    }
}

/// `ProviderModels` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelsDto {
    pub provider: &'static str,
    pub reachable: bool,
    pub message: Option<String>,
    pub detail: Option<String>,
    pub models: Vec<ModelInfoDto>,
}

/// `ModelPrice` in `src/api/types.ts` (input and output).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPriceDto {
    pub provider: String,
    pub model: String,
    pub input_per_m_tok: f64,
    pub output_per_m_tok: f64,
    pub currency: String,
}

impl From<ModelPrice> for ModelPriceDto {
    fn from(p: ModelPrice) -> Self {
        ModelPriceDto {
            provider: p.provider.as_str().to_owned(),
            model: p.model,
            input_per_m_tok: p.input_per_mtok,
            output_per_m_tok: p.output_per_mtok,
            currency: p.currency,
        }
    }
}

impl TryFrom<ModelPriceDto> for ModelPrice {
    type Error = AppError;

    fn try_from(p: ModelPriceDto) -> Result<Self, AppError> {
        Ok(ModelPrice {
            provider: parse_cloud_provider(&p.provider)?,
            model: p.model,
            input_per_mtok: p.input_per_m_tok,
            output_per_mtok: p.output_per_m_tok,
            currency: p.currency,
        })
    }
}

/// `RouteDecision` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteDecisionDto {
    pub model: ModelRefDto,
    pub cloud: bool,
    pub reason: String,
}

impl From<RouteDecision> for RouteDecisionDto {
    fn from(r: RouteDecision) -> Self {
        RouteDecisionDto {
            model: r.model.into(),
            cloud: r.cloud,
            reason: r.reason,
        }
    }
}

/// Element of `CloudPreview.sources`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSourceDto {
    pub n: u32,
    pub title: String,
    pub unit: u32,
    pub unit_kind: &'static str,
    pub chars: u64,
    pub via: &'static str,
    /// v0.5: transcript passages only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_ms: Option<u64>,
}

impl From<PreviewSource> for PreviewSourceDto {
    fn from(s: PreviewSource) -> Self {
        PreviewSourceDto {
            n: s.n,
            title: s.title,
            unit: s.unit,
            unit_kind: s.unit_kind.as_str(),
            chars: s.chars,
            via: s.via.as_str(),
            start_ms: s.start_ms,
        }
    }
}

/// `CloudPreview.estCost`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EstCostDto {
    pub min: MoneyDto,
    pub max: MoneyDto,
}

/// `CloudPreview` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudPreviewDto {
    pub token: String,
    pub route: RouteDecisionDto,
    pub provider_name: String,
    pub host: String,
    pub question: String,
    pub sources: Vec<PreviewSourceDto>,
    pub history_pairs: u32,
    pub history_chars: u64,
    pub total_chars: u64,
    pub est_input_tokens: u64,
    pub max_output_tokens: u64,
    pub est_cost: Option<EstCostDto>,
    pub query_embedded_by: Option<ModelRefDto>,
    pub expires_at: String,
}

impl From<CloudPreview> for CloudPreviewDto {
    fn from(p: CloudPreview) -> Self {
        CloudPreviewDto {
            token: p.token,
            route: p.route.into(),
            provider_name: p.provider_name,
            host: p.host,
            question: p.question,
            sources: map_all(p.sources),
            history_pairs: p.history_pairs,
            history_chars: p.history_chars,
            total_chars: p.total_chars,
            est_input_tokens: p.est_input_tokens,
            max_output_tokens: p.max_output_tokens,
            est_cost: p.est_cost.map(|(min, max)| EstCostDto {
                min: min.into(),
                max: max.into(),
            }),
            query_embedded_by: p.query_embedded_by.map(ModelRefDto::from),
            expires_at: p.expires_at,
        }
    }
}

/// `CloudEmbeddingEstimate` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudEmbeddingEstimateDto {
    pub provider: &'static str,
    pub model: String,
    pub chunks: u64,
    pub chars: u64,
    pub est_tokens: u64,
    pub est_cost: Option<MoneyDto>,
}

impl From<CloudEmbeddingEstimate> for CloudEmbeddingEstimateDto {
    fn from(e: CloudEmbeddingEstimate) -> Self {
        CloudEmbeddingEstimateDto {
            provider: e.provider.as_str(),
            model: e.model,
            chunks: e.chunks,
            chars: e.chars,
            est_tokens: e.est_tokens,
            est_cost: e.est_cost.map(MoneyDto::from),
        }
    }
}

/// `CloudRequest` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudRequestDto {
    pub id: i64,
    pub created_at: String,
    pub provider: &'static str,
    pub model: Option<String>,
    pub purpose: &'static str,
    pub project_id: Option<String>,
    pub conversation_id: Option<String>,
    pub chars_sent: u64,
    pub usage: Option<TokenUsageDto>,
    pub cost: Option<MoneyDto>,
    pub ok: bool,
    pub error: Option<String>,
}

impl From<CloudRequest> for CloudRequestDto {
    fn from(r: CloudRequest) -> Self {
        CloudRequestDto {
            id: r.id,
            created_at: r.created_at,
            provider: r.provider.as_str(),
            model: r.model,
            purpose: r.purpose.as_str(),
            project_id: r.project_id,
            conversation_id: r.conversation_id,
            chars_sent: r.chars_sent,
            usage: r.usage.map(TokenUsageDto::from),
            cost: r.cost.map(MoneyDto::from),
            ok: r.ok,
            error: r.error,
        }
    }
}

fn parse_cloud_provider(raw: &str) -> Result<CloudProvider, AppError> {
    Ok(CloudProvider::parse_field(raw, "provider")?)
}

/// Default number of log entries returned.
const CLOUD_LOG_DEFAULT: usize = 100;

fn provider_info(state: &AppState, provider: CloudProvider) -> ProviderInfoDto {
    // An unreadable keychain counts as "no key" here; get_keyring_status explains why.
    let has_key = matches!(state.cloud.keys().get(provider), Ok(Some(_)));
    ProviderInfoDto::new(provider, has_key)
}

/// Probes the system keychain (may talk to the OS keychain service).
#[tauri::command]
pub async fn get_keyring_status(app: AppHandle) -> Result<KeyringStatusDto, AppError> {
    blocking(move || {
        let state = app.state::<AppState>();
        Ok(state.cloud.keys().status().into())
    })
    .await
}

/// The five cloud providers, with whether a key is stored (never the key itself).
#[tauri::command]
pub async fn list_providers(app: AppHandle) -> Result<Vec<ProviderInfoDto>, AppError> {
    blocking(move || {
        let state = app.state::<AppState>();
        Ok(CloudProvider::ALL
            .into_iter()
            .map(|p| provider_info(&state, p))
            .collect())
    })
    .await
}

/// Stores the key in the system keychain only; `keyring_unavailable` when it cannot be
/// used (no plaintext fallback). The key is never returned, logged or stored elsewhere.
#[tauri::command]
pub async fn set_api_key(
    app: AppHandle,
    provider: String,
    key: String,
) -> Result<ProviderInfoDto, AppError> {
    let provider = parse_cloud_provider(&provider)?;
    blocking(move || {
        let state = app.state::<AppState>();
        let key = localis_core::validate_api_key(&key)?;
        state.cloud.keys().set(provider, &key)?;
        drop(key);
        state.wake_embedder();
        Ok(provider_info(&state, provider))
    })
    .await
}

#[tauri::command]
pub async fn delete_api_key(app: AppHandle, provider: String) -> Result<ProviderInfoDto, AppError> {
    let provider = parse_cloud_provider(&provider)?;
    blocking(move || {
        let state = app.state::<AppState>();
        state.cloud.keys().delete(provider)?;
        Ok(provider_info(&state, provider))
    })
    .await
}

/// Contacts the provider with its key only (logged as `list_models`). Without a key no
/// request is made.
#[tauri::command]
pub async fn list_provider_models(
    app: AppHandle,
    provider: String,
) -> Result<ProviderModelsDto, AppError> {
    let provider = parse_cloud_provider(&provider)?;
    blocking(move || {
        let state = app.state::<AppState>();
        let state: &AppState = &state;
        let m = localis_core::list_provider_models(state, &state.cloud, provider)?;
        Ok(ProviderModelsDto {
            provider: m.provider.as_str(),
            reachable: m.reachable,
            message: m.message,
            detail: m.detail,
            models: map_all(m.models),
        })
    })
    .await
}

#[tauri::command]
pub async fn list_prices(state: State<'_, AppState>) -> Result<Vec<ModelPriceDto>, AppError> {
    state.with_store(|store| Ok(map_all(store.list_prices()?)))
}

#[tauri::command]
pub async fn set_price(
    state: State<'_, AppState>,
    price: ModelPriceDto,
) -> Result<Vec<ModelPriceDto>, AppError> {
    let price = ModelPrice::try_from(price)?;
    state.with_store(|store| Ok(map_all(store.set_price(&price)?)))
}

#[tauri::command]
pub async fn delete_price(
    state: State<'_, AppState>,
    provider: String,
    model: String,
) -> Result<Vec<ModelPriceDto>, AppError> {
    let provider = parse_cloud_provider(&provider)?;
    state.with_store(|store| Ok(map_all(store.delete_price(provider, &model)?)))
}

/// `local_only` also revokes the cloud indexing consent; wakes the embedder.
#[tauri::command]
pub async fn set_project_cloud_policy(
    state: State<'_, AppState>,
    project_id: String,
    policy: String,
) -> Result<ProjectDto, AppError> {
    let policy = CloudPolicy::parse(&policy).ok_or_else(|| {
        AppError::from(CoreError::Validation {
            field: "policy",
            message: "Scelta non valida per l'uso del cloud.".to_owned(),
        })
    })?;
    let project =
        state.with_store(|store| Ok(store.set_project_cloud_policy(&project_id, policy)?))?;
    state.wake_embedder();
    Ok(project.into())
}

/// `null` when the configured embedding model is not a cloud model.
#[tauri::command]
pub async fn estimate_cloud_embedding(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Option<CloudEmbeddingEstimateDto>, AppError> {
    state.with_store(|store| {
        Ok(store
            .estimate_cloud_embedding(&project_id)?
            .map(CloudEmbeddingEstimateDto::from))
    })
}

#[tauri::command]
pub async fn set_cloud_embedding_consent(
    state: State<'_, AppState>,
    project_id: String,
    consent: bool,
) -> Result<ProjectDto, AppError> {
    let project =
        state.with_store(|store| Ok(store.set_cloud_embedding_consent(&project_id, consent)?))?;
    state.wake_embedder();
    Ok(project.into())
}

/// Retrieval + routing without storing anything or calling a chat model; `null` when no
/// cloud send is needed. Runs on a blocking thread (may contact LM Studio, and the cloud
/// embedding provider for projects that consented).
#[tauri::command]
pub async fn prepare_cloud_send(
    app: AppHandle,
    input: SendMessageInput,
) -> Result<Option<CloudPreviewDto>, AppError> {
    blocking(move || {
        let state = app.state::<AppState>();
        let state: &AppState = &state;
        let preview = localis_core::prepare_cloud_send(state, &state.cloud, &input.into())?;
        Ok(preview.map(CloudPreviewDto::from))
    })
    .await
}

/// Drops a prepared request the user did not confirm (no-op when unknown).
#[tauri::command]
pub async fn discard_cloud_send(state: State<'_, AppState>, token: String) -> Result<(), AppError> {
    state.cloud.discard(&token);
    Ok(())
}

/// Most recent first.
#[tauri::command]
pub async fn list_cloud_requests(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<CloudRequestDto>, AppError> {
    let limit = limit.unwrap_or(CLOUD_LOG_DEFAULT);
    state.with_store(|store| Ok(map_all(store.list_cloud_requests(limit)?)))
}
