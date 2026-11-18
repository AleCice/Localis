//! Integration tests on temporary database files (synthetic data only).

use std::path::{Path, PathBuf};

use localis_core::{CoreError, NewProject, Project, Store, NAME_MAX, SCHEMA_VERSION};
use rusqlite::Connection;
use tempfile::TempDir;

fn temp_db() -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("localis.db");
    (dir, path)
}

fn new(name: &str) -> NewProject {
    NewProject {
        name: name.to_owned(),
        description: None,
    }
}

fn create(store: &mut Store, name: &str) -> Project {
    store.create_project(new(name)).unwrap()
}

fn raw(path: &Path) -> Connection {
    Connection::open(path).unwrap()
}

fn assert_validation(err: CoreError, expected_field: &str, expected_message: &str) {
    match err {
        CoreError::Validation { field, message } => {
            assert_eq!(field, expected_field);
            assert_eq!(message, expected_message);
        }
        other => panic!("expected validation error, got {other:?}"),
    }
}

fn assert_duplicate(err: CoreError) {
    match err {
        CoreError::Duplicate { field, message } => {
            assert_eq!(field, "name");
            assert_eq!(message, "Esiste già un progetto con questo nome.");
        }
        other => panic!("expected duplicate error, got {other:?}"),
    }
}

fn is_iso_utc_millis(s: &str) -> bool {
    // YYYY-MM-DDTHH:MM:SS.mmmZ
    let b = s.as_bytes();
    b.len() == 24
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b'T',
            13 | 16 => *c == b':',
            19 => *c == b'.',
            23 => *c == b'Z',
            _ => c.is_ascii_digit(),
        })
}

// --- migrations ---

#[test]
fn migrates_from_scratch() {
    let (_dir, path) = temp_db();
    let nested = path.parent().unwrap().join("a/b/localis.db");
    let store = Store::open(&nested).unwrap();
    assert!(nested.exists(), "parent directories are created");
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    assert_eq!(SCHEMA_VERSION, 1);
    drop(store);

    let conn = raw(&nested);
    let version: u32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 1);
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(tables, vec!["projects".to_owned()]);
    let columns: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('projects') ORDER BY cid")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        columns,
        ["id", "name", "description", "created_at", "updated_at"]
    );
    let mode: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode.to_lowercase(), "wal");
}

#[test]
fn reopening_neither_loses_nor_duplicates_data() {
    let (_dir, path) = temp_db();
    let mut store = Store::open(&path).unwrap();
    let a = create(&mut store, "Alfa");
    let b = store
        .create_project(NewProject {
            name: "Beta".into(),
            description: Some("note".into()),
        })
        .unwrap();
    let before = store.list_projects().unwrap();
    drop(store);

    for _ in 0..3 {
        let store = Store::open(&path).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        let after = store.list_projects().unwrap();
        assert_eq!(after, before);
        assert_eq!(after.len(), 2);
        assert!(after.contains(&a) && after.contains(&b));
    }
    // Migration 1 has no IF NOT EXISTS: re-running it would have failed the reopen.
    let count: i64 = raw(&path)
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'projects'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn newer_schema_version_is_refused() {
    let (_dir, path) = temp_db();
    drop(Store::open(&path).unwrap());
    raw(&path)
        .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
        .unwrap();

    match Store::open(&path).unwrap_err() {
        CoreError::Storage { message, detail } => {
            assert_eq!(
                message,
                "Il database è stato creato da una versione più recente di Localis."
            );
            assert!(detail.contains("newer"), "{detail}");
        }
        other => panic!("expected storage error, got {other:?}"),
    }
    // The database is left untouched.
    let version: u32 = raw(&path)
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION + 1);
}

#[test]
fn opening_a_non_database_file_is_a_storage_error() {
    let (_dir, path) = temp_db();
    std::fs::write(
        &path,
        b"this is not a sqlite database, just synthetic bytes....",
    )
    .unwrap();
    let err = Store::open(&path).unwrap_err();
    assert!(matches!(err, CoreError::Storage { .. }), "{err:?}");
    assert!(err.detail().is_some());
}

// --- create & validation ---

#[test]
fn create_returns_normalized_project() {
    let mut store = Store::open_in_memory().unwrap();
    let p = store
        .create_project(NewProject {
            name: "  Tesi di laurea  ".into(),
            description: Some("  Capitolo 1\n".into()),
        })
        .unwrap();
    assert_eq!(p.name, "Tesi di laurea");
    assert_eq!(p.description.as_deref(), Some("Capitolo 1"));
    let uuid = uuid::Uuid::parse_str(&p.id).unwrap();
    assert_eq!(uuid.get_version_num(), 4);
    assert!(is_iso_utc_millis(&p.created_at), "{}", p.created_at);
    assert_eq!(p.created_at, p.updated_at);
    assert_eq!(store.list_projects().unwrap(), vec![p]);
}

#[test]
fn empty_description_becomes_none() {
    let mut store = Store::open_in_memory().unwrap();
    for (i, d) in [Some(""), Some("   \n\t"), None].into_iter().enumerate() {
        let p = store
            .create_project(NewProject {
                name: format!("P{i}"),
                description: d.map(str::to_owned),
            })
            .unwrap();
        assert_eq!(p.description, None);
    }
}

#[test]
fn invalid_names_rejected() {
    let mut store = Store::open_in_memory().unwrap();
    assert_validation(
        store.create_project(new("")).unwrap_err(),
        "name",
        "Inserisci un nome.",
    );
    assert_validation(
        store.create_project(new("   \t ")).unwrap_err(),
        "name",
        "Inserisci un nome.",
    );
    assert_validation(
        store
            .create_project(new(&"a".repeat(NAME_MAX + 1)))
            .unwrap_err(),
        "name",
        "Il nome può avere al massimo 120 caratteri.",
    );
    assert_validation(
        store.create_project(new("riga\nnuova")).unwrap_err(),
        "name",
        "Il nome contiene caratteri non validi.",
    );
    assert_validation(
        store.create_project(new("nul\u{0}")).unwrap_err(),
        "name",
        "Il nome contiene caratteri non validi.",
    );
    assert!(store.list_projects().unwrap().is_empty());
}

#[test]
fn name_of_exactly_max_length_accepted() {
    let mut store = Store::open_in_memory().unwrap();
    let ascii = "a".repeat(NAME_MAX);
    let accented = "é".repeat(NAME_MAX);
    assert_eq!(create(&mut store, &ascii).name, ascii);
    assert_eq!(create(&mut store, &accented).name, accented);
}

#[test]
fn too_long_description_rejected() {
    let mut store = Store::open_in_memory().unwrap();
    let err = store
        .create_project(NewProject {
            name: "Tesi".into(),
            description: Some("x".repeat(2001)),
        })
        .unwrap_err();
    assert_validation(
        err,
        "description",
        "La descrizione può avere al massimo 2000 caratteri.",
    );
    let ok = store
        .create_project(NewProject {
            name: "Tesi".into(),
            description: Some("x".repeat(2000)),
        })
        .unwrap();
    assert_eq!(ok.description.unwrap().len(), 2000);
}

#[test]
fn duplicates_rejected_case_insensitively() {
    let mut store = Store::open_in_memory().unwrap();
    create(&mut store, "Tesi");
    create(&mut store, "Èlite");
    assert_duplicate(store.create_project(new("tesi")).unwrap_err());
    assert_duplicate(store.create_project(new("  TESI  ")).unwrap_err());
    assert_duplicate(store.create_project(new("èlite")).unwrap_err());
    assert_duplicate(store.create_project(new(" ÈLITE ")).unwrap_err());
    assert_eq!(store.list_projects().unwrap().len(), 2);
    // Similar but different names are fine.
    create(&mut store, "Tesi 2");
    create(&mut store, "Elite");
}

#[test]
fn duplicate_check_survives_reopen() {
    let (_dir, path) = temp_db();
    create(&mut Store::open(&path).unwrap(), "Ricerca");
    let mut store = Store::open(&path).unwrap();
    assert_duplicate(store.create_project(new("ricerca")).unwrap_err());
}

// --- persistence & delete ---

#[test]
fn persists_across_connections() {
    let (_dir, path) = temp_db();
    let created = {
        let mut store = Store::open(&path).unwrap();
        store
            .create_project(NewProject {
                name: "Persistente".into(),
                description: Some("descrizione".into()),
            })
            .unwrap()
    };
    let store = Store::open(&path).unwrap();
    assert_eq!(store.list_projects().unwrap(), vec![created]);
}

#[test]
fn delete_removes_only_the_record_and_persists() {
    let (dir, path) = temp_db();
    let mut store = Store::open(&path).unwrap();
    let keep = create(&mut store, "Tieni");
    let gone = create(&mut store, "Elimina");
    let files_before = std::fs::read_dir(dir.path()).unwrap().count();

    store.delete_project(&gone.id).unwrap();
    assert_eq!(store.list_projects().unwrap(), vec![keep.clone()]);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), files_before);
    drop(store);

    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.list_projects().unwrap(), vec![keep]);
    // Deleting again: not found.
    match store.delete_project(&gone.id).unwrap_err() {
        CoreError::NotFound { message } => assert_eq!(message, "Il progetto non esiste più."),
        other => panic!("expected not found, got {other:?}"),
    }
    // A deleted name can be reused.
    create(&mut store, "Elimina");
}

#[test]
fn delete_unknown_id_is_not_found() {
    let mut store = Store::open_in_memory().unwrap();
    create(&mut store, "Uno");
    for id in [
        "",
        "non-esiste",
        "00000000-0000-4000-8000-000000000000",
        "' OR 1=1 --",
    ] {
        assert!(matches!(
            store.delete_project(id).unwrap_err(),
            CoreError::NotFound { .. }
        ));
    }
    assert_eq!(store.list_projects().unwrap().len(), 1);
}

#[test]
fn names_are_stored_verbatim_without_sql_injection() {
    let mut store = Store::open_in_memory().unwrap();
    let name = "Robert'); DROP TABLE projects; --";
    create(&mut store, name);
    assert_eq!(store.list_projects().unwrap()[0].name, name);
}

// --- ordering ---

#[test]
fn list_ordered_by_updated_then_created_then_id() {
    let (_dir, path) = temp_db();
    let mut store = Store::open(&path).unwrap();
    let ids: Vec<String> = ["A", "B", "C", "D", "E"]
        .iter()
        .map(|n| create(&mut store, n).id)
        .collect();
    drop(store);

    let conn = raw(&path);
    let set = |id: &str, created: &str, updated: &str| {
        conn.execute(
            "UPDATE projects SET created_at = ?2, updated_at = ?3 WHERE id = ?1",
            rusqlite::params![id, created, updated],
        )
        .unwrap();
    };
    set(
        &ids[0],
        "2026-01-01T00:00:00.000Z",
        "2026-03-01T00:00:00.000Z",
    );
    set(
        &ids[1],
        "2026-01-02T00:00:00.000Z",
        "2026-02-01T00:00:00.000Z",
    );
    set(
        &ids[2],
        "2026-01-03T00:00:00.000Z",
        "2026-02-01T00:00:00.000Z",
    );
    set(
        &ids[3],
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
    );
    set(
        &ids[4],
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
    );
    drop(conn);

    let names: Vec<String> = Store::open(&path)
        .unwrap()
        .list_projects()
        .unwrap()
        .into_iter()
        .map(|p| p.name)
        .collect();
    let (d_first, e_first) = (["D", "E"], ["E", "D"]);
    let tail = if ids[3] < ids[4] { d_first } else { e_first };
    let expected: Vec<&str> = ["A", "C", "B"].into_iter().chain(tail).collect();
    assert_eq!(names, expected);
}
