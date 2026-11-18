use std::sync::{Mutex, MutexGuard};

use localis_core::{NewProject, Project, Store};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::AppError;

/// Managed state: the open store, or the error that prevented opening it, so every
/// command can report it to the UI instead of the app failing silently.
pub struct AppState {
    store: Result<Mutex<Store>, AppError>,
}

impl AppState {
    pub fn new(store: Result<Store, AppError>) -> Self {
        AppState {
            store: store.map(Mutex::new),
        }
    }

    pub(crate) fn lock(&self) -> Result<MutexGuard<'_, Store>, AppError> {
        match &self.store {
            Ok(mutex) => mutex
                .lock()
                .map_err(|_| AppError::internal("store mutex poisoned")),
            Err(err) => Err(err.clone()),
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
    let store = state.lock()?;
    Ok(store
        .list_projects()?
        .into_iter()
        .map(ProjectDto::from)
        .collect())
}

#[tauri::command]
pub async fn create_project(
    state: State<'_, AppState>,
    input: NewProjectInput,
) -> Result<ProjectDto, AppError> {
    let mut store = state.lock()?;
    let project = store.create_project(NewProject {
        name: input.name,
        description: input.description,
    })?;
    Ok(project.into())
}

#[tauri::command]
pub async fn delete_project(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let mut store = state.lock()?;
    store.delete_project(&id)?;
    Ok(())
}
