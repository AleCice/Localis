mod commands;
mod error;
mod headers;
mod lectures;
mod media_protocol;

#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::mpsc;

use std::sync::Arc;

use localis_core::{
    CloudEnv, CloudRuntime, CoreError, EmbedderConfig, EmbedderShared, Endpoints, ModelManager,
    Store, SystemKeyring, TranscriberConfig, Uploads, WhisperTranscriber, WorkerConfig, MODELS_DIR,
    ORIGINALS_DIR,
};
use tauri::Manager;

use crate::commands::AppState;
use crate::error::AppError;

const DB_FILE: &str = "localis.db";

fn db_path(app: &tauri::App) -> Result<PathBuf, AppError> {
    let dir = app.path().app_data_dir().map_err(|err| {
        AppError::from(CoreError::Storage {
            message: "Impossibile aprire il database.".to_owned(),
            detail: format!("cannot resolve app data directory: {err}"),
        })
    })?;
    Ok(dir.join(DB_FILE))
}

/// Starts the background extraction worker on its own thread and SQLite connection.
/// Originals live in `<app_data_dir>/originals`, next to the database.
fn spawn_worker(path: Result<PathBuf, AppError>) -> Option<mpsc::SyncSender<()>> {
    let path = path.ok()?;
    let (wake, signals) = mpsc::sync_channel(1);
    let spawned = std::thread::Builder::new()
        .name("localis-worker".into())
        .spawn(move || {
            localis_core::run_worker(|| Store::open(&path), signals, WorkerConfig::default())
        });
    match spawned {
        Ok(_) => Some(wake),
        Err(err) => {
            eprintln!("localis: cannot start the extraction worker: {err}");
            None
        }
    }
}

/// Starts the background embedder on its own thread and SQLite connection. It talks to
/// the loopback LM Studio URL saved in the settings or, for a cloud embedding model, to the
/// provider's fixed host for consenting projects only.
fn spawn_embedder(
    path: Result<PathBuf, AppError>,
    cloud: CloudEnv,
) -> Option<(mpsc::SyncSender<()>, Arc<EmbedderShared>)> {
    let path = path.ok()?;
    let (wake, signals) = mpsc::sync_channel(1);
    let shared = EmbedderShared::new();
    let thread_shared = Arc::clone(&shared);
    let spawned = std::thread::Builder::new()
        .name("localis-embedder".into())
        .spawn(move || {
            localis_core::run_embedder(
                || Store::open(&path),
                signals,
                thread_shared,
                EmbedderConfig::default(),
                cloud,
            )
        });
    match spawned {
        Ok(_) => Some((wake, shared)),
        Err(err) => {
            eprintln!("localis: cannot start the embedder: {err}");
            None
        }
    }
}

/// v0.5: starts the transcription worker on its own thread and SQLite connection, separate
/// from the extraction worker so extraction never waits behind a long transcription. After
/// each transcription it wakes the embedder (`on_done`).
fn spawn_transcriber(
    path: Result<PathBuf, AppError>,
    models: Arc<ModelManager>,
    embedder: Option<mpsc::SyncSender<()>>,
) -> Option<mpsc::SyncSender<()>> {
    let path = path.ok()?;
    let (wake, signals) = mpsc::sync_channel(1);
    let spawned = std::thread::Builder::new()
        .name("localis-transcriber".into())
        .spawn(move || {
            localis_core::run_transcriber(
                || Store::open(&path),
                signals,
                TranscriberConfig::default(),
                Arc::new(WhisperTranscriber),
                models,
                move || {
                    if let Some(wake) = &embedder {
                        let _ = wake.try_send(());
                    }
                },
            )
        });
    match spawned {
        Ok(_) => Some(wake),
        Err(err) => {
            eprintln!("localis: cannot start the transcription worker: {err}");
            None
        }
    }
}

/// v0.5: discards chunked uploads idle for more than an hour, every few minutes.
fn spawn_upload_sweeper(uploads: Arc<Uploads>) {
    let spawned = std::thread::Builder::new()
        .name("localis-upload-sweeper".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(300));
            uploads.sweep_expired();
        });
    if let Err(err) = spawned {
        eprintln!("localis: cannot start the upload sweeper: {err}");
    }
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // If the database cannot be opened the app still starts: commands return
            // the error (logged by the AppError conversion) so the UI can show it, and
            // each later command retries opening. The worker retries on its own.
            let path = db_path(app);
            let wake = spawn_worker(path.clone());
            // API keys live only in the system keychain. Cloud endpoints are the fixed
            // hosts (debug builds also read the LOCALIS_TEST_* overrides, see localis-core).
            let cloud = CloudRuntime::new(Arc::new(SystemKeyring::new()), Endpoints::from_env());
            let embedder = spawn_embedder(path.clone(), cloud.env.clone());
            // v0.5: uploads in `originals/.uploads`, Whisper models in `models/whisper`
            // (never deleted with projects). Leftovers of interrupted runs are removed now.
            let data_dir = path
                .as_ref()
                .ok()
                .and_then(|p| p.parent())
                .map(PathBuf::from);
            let lectures = data_dir.map(|dir| {
                let uploads = Arc::new(Uploads::new(&dir.join(ORIGINALS_DIR)));
                uploads.sweep_all();
                let models = Arc::new(ModelManager::new(dir.join(MODELS_DIR)));
                models.sweep_temp_files();
                (uploads, models)
            });
            let transcriber = lectures.as_ref().and_then(|(_, models)| {
                spawn_transcriber(
                    path.clone(),
                    Arc::clone(models),
                    embedder.as_ref().map(|(wake, _)| wake.clone()),
                )
            });
            // Answers left `streaming` by a crash are marked failed as soon as the store
            // opens, before any generation can start (generations only run in this process).
            let mut state = AppState::new(move || {
                let mut store = Store::open(path.as_ref().map_err(Clone::clone)?)?;
                store.recover_interrupted_messages()?;
                Ok(store)
            })
            .with_cloud(cloud);
            // Leftovers of interrupted imports, removed before any command can import.
            let _ = state.with_store(|store| {
                store.sweep_temp_files();
                Ok(())
            });
            if let Some(wake) = wake {
                state = state.with_worker(wake);
            }
            if let Some((wake, shared)) = embedder {
                state = state.with_embedder(wake, shared);
            }
            if let Some((uploads, models)) = lectures {
                spawn_upload_sweeper(Arc::clone(&uploads));
                state = state.with_uploads(uploads).with_models(models);
            }
            if let Some(wake) = transcriber {
                state = state.with_transcriber(wake);
            }
            app.manage(state);
            Ok(())
        })
        // v0.5: audio/video playback with HTTP Range (see media_protocol.rs).
        .register_asynchronous_uri_scheme_protocol("localis-media", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let state = app.state::<AppState>();
                responder.respond(media_protocol::handle(&state, &request));
            });
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_projects,
            commands::create_project,
            commands::delete_project,
            commands::list_folders,
            commands::create_folder,
            commands::rename_folder,
            commands::delete_folder,
            commands::list_documents,
            commands::list_versions,
            commands::import_document,
            commands::import_version,
            commands::move_document,
            commands::delete_document,
            commands::read_original,
            commands::get_text,
            commands::search,
            commands::list_jobs,
            commands::retry_job,
            commands::get_llm_settings,
            commands::set_llm_settings,
            commands::get_llm_status,
            commands::get_embedding_status,
            commands::list_conversations,
            commands::create_conversation,
            commands::delete_conversation,
            commands::list_messages,
            commands::send_message,
            commands::cancel_generation,
            commands::get_keyring_status,
            commands::list_providers,
            commands::set_api_key,
            commands::delete_api_key,
            commands::list_provider_models,
            commands::list_prices,
            commands::set_price,
            commands::delete_price,
            commands::set_project_cloud_policy,
            commands::estimate_cloud_embedding,
            commands::set_cloud_embedding_consent,
            commands::prepare_cloud_send,
            commands::discard_cloud_send,
            commands::list_cloud_requests,
            lectures::begin_upload,
            lectures::upload_chunk,
            lectures::finish_upload,
            lectures::cancel_upload,
            lectures::list_whisper_models,
            lectures::download_whisper_model,
            lectures::cancel_whisper_download,
            lectures::delete_whisper_model,
            lectures::start_transcription,
            lectures::cancel_job,
            lectures::get_transcript,
            lectures::list_media_links,
            lectures::list_links_for_target,
            lectures::create_media_link,
            lectures::update_media_link,
            lectures::delete_media_link,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Localis");
}
