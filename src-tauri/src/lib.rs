mod commands;
mod error;
mod headers;

#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::mpsc;

use std::sync::Arc;

use localis_core::{CoreError, EmbedderConfig, EmbedderShared, Store, WorkerConfig};
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

/// Starts the background embedder on its own thread and SQLite connection. It only talks
/// to the loopback LM Studio URL saved in the settings.
fn spawn_embedder(
    path: Result<PathBuf, AppError>,
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

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // If the database cannot be opened the app still starts: commands return
            // the error (logged by the AppError conversion) so the UI can show it, and
            // each later command retries opening. The worker retries on its own.
            let path = db_path(app);
            let wake = spawn_worker(path.clone());
            let embedder = spawn_embedder(path.clone());
            // Answers left `streaming` by a crash are marked failed as soon as the store
            // opens, before any generation can start (generations only run in this process).
            let mut state = AppState::new(move || {
                let mut store = Store::open(path.as_ref().map_err(Clone::clone)?)?;
                store.recover_interrupted_messages()?;
                Ok(store)
            });
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
            app.manage(state);
            Ok(())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Localis");
}
