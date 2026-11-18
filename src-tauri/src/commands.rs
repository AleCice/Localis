use std::sync::{Mutex, MutexGuard};

use localis_core::{NewProject, Project, Store};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::AppError;

type Opener = Box<dyn Fn() -> Result<Store, AppError> + Send + Sync>;

/// Managed state: the store, opened lazily. If opening fails, the error is returned to
/// the UI and the next command tries again, so «Riprova» can recover from a transient
/// failure (e.g. the database locked by another process) without restarting the app.
pub struct AppState {
    opener: Opener,
    store: Mutex<Option<Store>>,
}

impl AppState {
    pub fn new(opener: impl Fn() -> Result<Store, AppError> + Send + Sync + 'static) -> Self {
        let store = opener().ok();
        AppState {
            opener: Box::new(opener),
            store: Mutex::new(store),
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
