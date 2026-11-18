//! Tests for the error mapping and the JSON contract with `src/api/types.ts`.
//! JSON is produced through Tauri's own IPC serialization (the same path used for
//! command responses), so no extra dev-dependency is needed.

use localis_core::{CoreError, NewProject, Store};
use serde::de::value::{Error as DeError, MapDeserializer};
use serde::Deserialize;
use tauri::ipc::{InvokeResponseBody, IpcResponse};

use crate::commands::{AppState, NewProjectInput, ProjectDto};
use crate::error::{AppError, ErrorCode};

fn to_json<T: serde::Serialize>(value: T) -> String {
    match value.body().unwrap() {
        InvokeResponseBody::Json(json) => json,
        InvokeResponseBody::Raw(_) => panic!("expected JSON body"),
    }
}

#[test]
fn validation_error_mapping() {
    let mut store = Store::open_in_memory().unwrap();
    let err: AppError = store
        .create_project(NewProject {
            name: "   ".into(),
            description: None,
        })
        .unwrap_err()
        .into();
    assert_eq!(err.code, ErrorCode::Validation);
    assert_eq!(err.message, "Inserisci un nome.");
    assert_eq!(err.field.as_deref(), Some("name"));
    assert_eq!(err.detail, None);
    assert_eq!(
        to_json(err),
        r#"{"code":"validation","message":"Inserisci un nome.","field":"name"}"#
    );
}

#[test]
fn duplicate_error_mapping() {
    let mut store = Store::open_in_memory().unwrap();
    let input = || NewProject {
        name: "Tesi".into(),
        description: None,
    };
    store.create_project(input()).unwrap();
    let err: AppError = store.create_project(input()).unwrap_err().into();
    assert_eq!(err.code, ErrorCode::Duplicate);
    assert_eq!(err.field.as_deref(), Some("name"));
    assert_eq!(
        to_json(err),
        r#"{"code":"duplicate","message":"Esiste già un progetto con questo nome.","field":"name"}"#
    );
}

#[test]
fn not_found_error_mapping() {
    let mut store = Store::open_in_memory().unwrap();
    let err: AppError = store.delete_project("missing").unwrap_err().into();
    assert_eq!(err.code, ErrorCode::NotFound);
    assert_eq!(err.field, None);
    assert_eq!(err.detail, None);
    assert_eq!(
        to_json(err),
        r#"{"code":"not_found","message":"Il progetto non esiste più."}"#
    );
}

#[test]
fn storage_error_keeps_detail_out_of_message() {
    // A real storage failure: a file that is not a SQLite database.
    let dir = tempdir();
    let path = dir.join("localis.db");
    std::fs::write(
        &path,
        b"synthetic bytes, definitely not a sqlite database file",
    )
    .unwrap();
    let err: AppError = Store::open(&path).unwrap_err().into();
    std::fs::remove_dir_all(&dir).unwrap();
    assert_eq!(err.code, ErrorCode::Storage);
    assert_eq!(err.message, "Impossibile aprire il database.");
    assert_eq!(err.field, None);
    let detail = err.detail.clone().unwrap();
    assert!(!detail.is_empty());
    assert!(!err.message.contains(&detail));
    let json = to_json(err);
    assert!(
        json.starts_with(
            r#"{"code":"storage","message":"Impossibile aprire il database.","detail":"#
        ),
        "{json}"
    );
}

#[test]
fn internal_error_mapping() {
    let err: AppError = CoreError::Internal("boom".into()).into();
    assert_eq!(err.code, ErrorCode::Internal);
    assert_eq!(err.message, "Si è verificato un errore imprevisto.");
    assert_eq!(err.detail.as_deref(), Some("boom"));
    assert_eq!(
        to_json(err),
        r#"{"code":"internal","message":"Si è verificato un errore imprevisto.","detail":"boom"}"#
    );
}

#[test]
fn project_dto_is_camel_case_with_nullable_description() {
    let dto = ProjectDto {
        id: "id-1".into(),
        name: "Tesi".into(),
        description: None,
        created_at: "2026-01-01T00:00:00.000Z".into(),
        updated_at: "2026-01-02T00:00:00.000Z".into(),
    };
    assert_eq!(
        to_json(dto.clone()),
        r#"{"id":"id-1","name":"Tesi","description":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-02T00:00:00.000Z"}"#
    );
    let with_description = ProjectDto {
        description: Some("note".into()),
        ..dto
    };
    assert!(to_json(with_description).contains(r#""description":"note""#));
}

#[test]
fn new_project_input_description_is_optional() {
    let input = NewProjectInput::deserialize(MapDeserializer::<_, DeError>::new(
        [("name", "Tesi")].into_iter(),
    ))
    .unwrap();
    assert_eq!(
        input,
        NewProjectInput {
            name: "Tesi".into(),
            description: None
        }
    );
    // A present description is not exercised here: serde's value deserializer cannot
    // turn a plain string into `Some`, and serde_json is not a dev-dependency.
}

#[test]
fn failed_open_is_reported_and_retried() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let open_err: AppError = CoreError::Storage {
        message: "Impossibile aprire il database.".into(),
        detail: "synthetic failure".into(),
    }
    .into();
    // Fails on the first two attempts (startup + first command), then succeeds.
    let attempts = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&attempts);
    let err = open_err.clone();
    let state = AppState::new(move || {
        if counter.fetch_add(1, Ordering::SeqCst) < 2 {
            Err(err.clone())
        } else {
            Ok(Store::open_in_memory().unwrap())
        }
    });
    assert_eq!(
        state.with_store(|s| Ok(s.list_projects()?)).unwrap_err(),
        open_err
    );
    assert!(state
        .with_store(|s| Ok(s.list_projects()?))
        .unwrap()
        .is_empty());
    // Once open, the store is reused rather than reopened.
    state.with_store(|s| Ok(s.list_projects()?)).unwrap();
    assert_eq!(attempts.load(Ordering::SeqCst), 3);
}

/// Unique temporary directory (std only: tempfile is not a dependency of this crate).
fn tempdir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "localis-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
