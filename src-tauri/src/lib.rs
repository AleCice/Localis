mod commands;
mod error;

#[cfg(test)]
mod tests;

use localis_core::{CoreError, Store};
use tauri::Manager;

use crate::commands::AppState;
use crate::error::AppError;

const DB_FILE: &str = "localis.db";

fn open_store(app: &tauri::App) -> Result<Store, AppError> {
    let dir = app.path().app_data_dir().map_err(|err| {
        AppError::from(CoreError::Storage {
            message: "Impossibile aprire il database.".to_owned(),
            detail: format!("cannot resolve app data directory: {err}"),
        })
    })?;
    Ok(Store::open(&dir.join(DB_FILE))?)
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // If the database cannot be opened the app still starts (the error is
            // logged by the AppError conversion) and every command returns it, so
            // the UI can show it.
            app.manage(AppState::new(open_store(app)));
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
