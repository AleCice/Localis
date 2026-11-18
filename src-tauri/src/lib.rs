mod commands;
mod error;

#[cfg(test)]
mod tests;

use std::path::PathBuf;

use localis_core::{CoreError, Store};
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

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // If the database cannot be opened the app still starts: commands return
            // the error (logged by the AppError conversion) so the UI can show it, and
            // each later command retries opening.
            let path = db_path(app);
            app.manage(AppState::new(move || {
                Ok(Store::open(path.as_ref().map_err(Clone::clone)?)?)
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_projects,
            commands::create_project,
            commands::delete_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running Localis");
}
