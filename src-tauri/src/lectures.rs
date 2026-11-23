//! v0.5 FARO commands: chunked upload, Whisper models, transcription jobs, transcripts and
//! media links. Thin wrappers over `localis_core`; DTOs mirror `src/api/types.ts`.

use std::sync::Arc;

use localis_core::{
    parse_language, BeginUpload, MediaLink, MediaLinkInput, ModelManager, Region,
    TranscriptSegment, TranscriptionInfo, UploadHandle, Uploads, WhisperModel, WhisperModelId,
    MODEL_NOT_INSTALLED,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Request;
use tauri::{AppHandle, Manager, State};

use crate::commands::{blocking, map_all, AppState, ImportResultDto, JobDto};
use crate::error::AppError;
use crate::headers::{raw_body, ChunkHeaders};

fn uploads(state: &AppState) -> Result<Arc<Uploads>, AppError> {
    state
        .uploads
        .clone()
        .ok_or_else(|| AppError::internal("uploads not available (no app data directory)"))
}

fn models(state: &AppState) -> Result<Arc<ModelManager>, AppError> {
    state
        .models
        .clone()
        .ok_or_else(|| AppError::internal("models not available (no app data directory)"))
}

// ---------------------------------------------------------------- DTOs

/// `BeginUploadInput` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginUploadInput {
    pub project_id: String,
    #[serde(default)]
    pub folder_id: Option<String>,
    pub file_name: String,
    pub size_bytes: u64,
    #[serde(default)]
    pub last_modified: Option<i64>,
    #[serde(default)]
    pub document_id: Option<String>,
}

impl From<BeginUploadInput> for BeginUpload {
    fn from(i: BeginUploadInput) -> Self {
        BeginUpload {
            project_id: i.project_id,
            folder_id: i.folder_id.filter(|f| !f.is_empty()),
            file_name: i.file_name,
            size_bytes: i.size_bytes,
            last_modified: i.last_modified,
            document_id: i.document_id.filter(|d| !d.is_empty()),
        }
    }
}

/// `UploadHandle` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadHandleDto {
    pub upload_id: String,
    pub chunk_bytes: u64,
}

impl From<UploadHandle> for UploadHandleDto {
    fn from(h: UploadHandle) -> Self {
        UploadHandleDto {
            upload_id: h.upload_id,
            chunk_bytes: h.chunk_bytes,
        }
    }
}

/// `WhisperModel.download` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadDto {
    pub received_bytes: u64,
    pub total_bytes: u64,
}

/// `WhisperModel` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperModelDto {
    pub id: &'static str,
    pub name: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub installed: bool,
    pub download: Option<DownloadDto>,
    pub error: Option<String>,
}

impl From<WhisperModel> for WhisperModelDto {
    fn from(m: WhisperModel) -> Self {
        WhisperModelDto {
            id: m.spec.id.as_str(),
            name: m.spec.name,
            file_name: m.spec.file_name,
            size_bytes: m.spec.size_bytes,
            sha256: m.spec.sha256,
            installed: m.installed,
            download: m.download.map(|(received, total)| DownloadDto {
                received_bytes: received,
                total_bytes: total,
            }),
            error: m.error,
        }
    }
}

/// `TranscriptionInfo` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionInfoDto {
    pub model: String,
    pub language: String,
    pub created_at: String,
    pub segment_count: u32,
}

impl From<TranscriptionInfo> for TranscriptionInfoDto {
    fn from(t: TranscriptionInfo) -> Self {
        TranscriptionInfoDto {
            model: t.model,
            language: t.language,
            created_at: t.created_at,
            segment_count: t.segment_count,
        }
    }
}

/// `TranscriptSegment` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegmentDto {
    pub index: u32,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

impl From<TranscriptSegment> for TranscriptSegmentDto {
    fn from(s: TranscriptSegment) -> Self {
        TranscriptSegmentDto {
            index: s.index,
            start_ms: s.start_ms,
            end_ms: s.end_ms,
            text: s.text,
        }
    }
}

/// `Region` in `src/api/types.ts` (input and output).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RegionDto {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// `MediaLink` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaLinkDto {
    pub id: String,
    pub project_id: String,
    pub media_document_id: String,
    pub media_version_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub target_document_id: String,
    pub target_version_id: String,
    pub target_page: Option<u32>,
    pub region: Option<RegionDto>,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub media_title: String,
    pub target_title: String,
    pub available: bool,
}

impl From<MediaLink> for MediaLinkDto {
    fn from(l: MediaLink) -> Self {
        MediaLinkDto {
            id: l.id,
            project_id: l.project_id,
            media_document_id: l.media_document_id,
            media_version_id: l.media_version_id,
            start_ms: l.start_ms,
            end_ms: l.end_ms,
            target_document_id: l.target_document_id,
            target_version_id: l.target_version_id,
            target_page: l.target_page,
            region: l.region.map(|r| RegionDto {
                x: r.x,
                y: r.y,
                w: r.w,
                h: r.h,
            }),
            note: l.note,
            created_at: l.created_at,
            updated_at: l.updated_at,
            media_title: l.media_title,
            target_title: l.target_title,
            available: l.available,
        }
    }
}

/// `MediaLinkInput` in `src/api/types.ts`. Times are signed so that a negative value is a
/// validation error with a message, not a deserialization failure.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaLinkInputDto {
    pub media_version_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub target_version_id: String,
    #[serde(default)]
    pub target_page: Option<i64>,
    #[serde(default)]
    pub region: Option<RegionDto>,
    #[serde(default)]
    pub note: Option<String>,
}

impl From<MediaLinkInputDto> for MediaLinkInput {
    fn from(i: MediaLinkInputDto) -> Self {
        MediaLinkInput {
            media_version_id: i.media_version_id,
            start_ms: i.start_ms,
            end_ms: i.end_ms,
            target_version_id: i.target_version_id,
            target_page: i.target_page,
            region: i.region.map(|r| Region {
                x: r.x,
                y: r.y,
                w: r.w,
                h: r.h,
            }),
            note: i.note,
        }
    }
}

// ---------------------------------------------------------------- chunked upload

#[tauri::command]
pub async fn begin_upload(
    state: State<'_, AppState>,
    input: BeginUploadInput,
) -> Result<UploadHandleDto, AppError> {
    let uploads = uploads(&state)?;
    let input = BeginUpload::from(input);
    state.with_store(|store| Ok(store.check_upload_target(&input)?))?;
    Ok(uploads.begin(input)?.into())
}

/// Raw body: one block of the file (at most `UPLOAD_CHUNK_BYTES`); id and offset in headers.
#[tauri::command]
pub async fn upload_chunk(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<(), AppError> {
    let bytes = raw_body(request.body())?;
    let meta = ChunkHeaders::parse(request.headers())?;
    Ok(uploads(&state)?.write_chunk(&meta.upload_id, meta.offset, bytes)?)
}

#[tauri::command]
pub async fn finish_upload(app: AppHandle, upload_id: String) -> Result<ImportResultDto, AppError> {
    blocking(move || {
        let state = app.state::<AppState>();
        let finished = uploads(&state)?.finish(&upload_id)?;
        // Format and duration are read from the file before taking the store lock.
        let file = finished.prepare()?;
        let outcome = state.with_store(|store| Ok(store.import_upload(&finished, &file)?))?;
        // `finished` is dropped here: its temporary file is removed unless it was moved.
        drop(finished);
        state.wake_worker();
        Ok(outcome.into())
    })
    .await
}

#[tauri::command]
pub async fn cancel_upload(state: State<'_, AppState>, upload_id: String) -> Result<(), AppError> {
    uploads(&state)?.cancel(&upload_id);
    Ok(())
}

// ---------------------------------------------------------------- Whisper models

fn model_list(models: &ModelManager) -> Vec<WhisperModelDto> {
    map_all(models.list())
}

#[tauri::command]
pub async fn list_whisper_models(
    state: State<'_, AppState>,
) -> Result<Vec<WhisperModelDto>, AppError> {
    Ok(model_list(&models(&state)?))
}

/// Starts the download (after the user confirmed the size in the UI); returns at once.
#[tauri::command]
pub async fn download_whisper_model(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<WhisperModelDto>, AppError> {
    let models = models(&state)?;
    models.start_download(WhisperModelId::parse_input(&id)?)?;
    Ok(model_list(&models))
}

#[tauri::command]
pub async fn cancel_whisper_download(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<WhisperModelDto>, AppError> {
    let models = models(&state)?;
    models.cancel_download(WhisperModelId::parse_input(&id)?);
    Ok(model_list(&models))
}

#[tauri::command]
pub async fn delete_whisper_model(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<WhisperModelDto>, AppError> {
    let models = models(&state)?;
    let id = WhisperModelId::parse_input(&id)?;
    // Not while a transcription with this model is running (its file is in use).
    let busy = state.with_store(|store| Ok(store.model_in_use(id)?))?;
    if busy {
        return Err(localis_core::CoreError::Conflict {
            message: "Il modello è in uso da una trascrizione in corso.".to_owned(),
        }
        .into());
    }
    models.delete(id)?;
    Ok(model_list(&models))
}

// ---------------------------------------------------------------- transcription

#[tauri::command]
pub async fn start_transcription(
    state: State<'_, AppState>,
    version_id: String,
    model: String,
    language: String,
) -> Result<JobDto, AppError> {
    let model = WhisperModelId::parse_input(&model)?;
    let language = parse_language(&language)?;
    if models(&state)?.installed_path(model).is_none() {
        return Err(localis_core::CoreError::Conflict {
            message: MODEL_NOT_INSTALLED.to_owned(),
        }
        .into());
    }
    let job =
        state.with_store(|store| Ok(store.start_transcription(&version_id, model, language)?))?;
    state.wake_transcriber();
    Ok(job.into())
}

#[tauri::command]
pub async fn cancel_job(state: State<'_, AppState>, id: i64) -> Result<JobDto, AppError> {
    let job = state.with_store(|store| Ok(store.cancel_job(id)?))?;
    state.wake_worker();
    state.wake_transcriber();
    Ok(job.into())
}

#[tauri::command]
pub async fn get_transcript(
    state: State<'_, AppState>,
    version_id: String,
) -> Result<Vec<TranscriptSegmentDto>, AppError> {
    state.with_store(|store| Ok(map_all(store.get_transcript(&version_id)?)))
}

// ---------------------------------------------------------------- media links

#[tauri::command]
pub async fn list_media_links(
    state: State<'_, AppState>,
    media_version_id: String,
) -> Result<Vec<MediaLinkDto>, AppError> {
    state.with_store(|store| Ok(map_all(store.list_media_links(&media_version_id)?)))
}

#[tauri::command]
pub async fn list_links_for_target(
    state: State<'_, AppState>,
    target_version_id: String,
) -> Result<Vec<MediaLinkDto>, AppError> {
    state.with_store(|store| Ok(map_all(store.list_links_for_target(&target_version_id)?)))
}

#[tauri::command]
pub async fn create_media_link(
    state: State<'_, AppState>,
    input: MediaLinkInputDto,
) -> Result<MediaLinkDto, AppError> {
    let input = MediaLinkInput::from(input);
    state.with_store(|store| Ok(store.create_media_link(&input)?.into()))
}

#[tauri::command]
pub async fn update_media_link(
    state: State<'_, AppState>,
    id: String,
    input: MediaLinkInputDto,
) -> Result<MediaLinkDto, AppError> {
    let input = MediaLinkInput::from(input);
    state.with_store(|store| Ok(store.update_media_link(&id, &input)?.into()))
}

#[tauri::command]
pub async fn delete_media_link(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.with_store(|store| Ok(store.delete_media_link(&id)?))
}
